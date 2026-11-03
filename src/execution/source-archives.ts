import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { StateError } from '../state/state-common.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const fileSchema = z.object({ path: z.string().min(1), mode: z.number().int().min(0).max(0o777), data: z.string(), sha256: sha }).strict();
const manifestSchema = z.object({
  version: z.literal(1), head: oid, headRef: z.string().nullable(),
  refs: z.array(z.object({ name: z.string(), oid }).strict()),
  bundle: z.string(), bundleHash: sha,
  index: z.array(z.object({ path: z.string(), mode: z.string().regex(/^100(?:644|755)$/), oid, data: z.string(), stage: z.number().int().min(0).max(3) }).strict()),
  files: z.array(fileSchema),
}).strict();
export type SourceManifest = z.infer<typeof manifestSchema>;
export type SourceArchivePolicy = {
  scratchDirectory: string; maxArchiveBytes: number; maxExpandedBytes: number; maxFiles: number;
  gitTimeoutMs: number; excludedPaths: string[];
};
export type SourceArchive = { bytes: Buffer; sha256: string; head: string; manifestVersion: 1 };

export function sourceHash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Trusted capture never runs checkout, filters, candidate hooks or project scripts. */
export class SourceArchives {
  constructor(private readonly policy: SourceArchivePolicy) {
    for (const value of [policy.maxArchiveBytes, policy.maxExpandedBytes, policy.maxFiles, policy.gitTimeoutMs]) {
      z.number().int().positive().safe().parse(value);
    }
    for (const path of policy.excludedPaths) safePath(path);
    mkdirSync(policy.scratchDirectory, { recursive: true, mode: 0o700 });
  }

  capture(workspace: string): SourceArchive {
    const root = realpathSync(workspace);
    const scratchPath = relative(root,realpathSync(this.policy.scratchDirectory));
    if (scratchPath === '' || (!scratchPath.startsWith(`..${sep}`) && scratchPath !== '..' && !scratchPath.startsWith(sep))) this.reject('Scratch storage must be outside source workspace');
    const gitDir = join(root, '.git');
    if (!lstatSync(gitDir).isDirectory() || lstatSync(gitDir).isSymbolicLink()) this.reject('Standalone .git directory required');
    for (const path of ['objects/info/alternates', 'objects/info/http-alternates', 'info/grafts', 'shallow']) {
      if (this.exists(join(gitDir, path))) this.reject('External or incomplete Git objects are unsupported');
    }
    this.assertRegularTree(gitDir);
    const files = this.walk(root).filter(path => path !== '.git' && !path.startsWith('.git/'));
    const entries = this.git(root, ['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean);
    const index = entries.map(entry => {
      const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match) this.reject('Unsupported Git index entry');
      const mode = match[1]; const objectId = match[2]; const stage = match[3]; const path = match[4];
      if (!mode || !objectId || !stage || !path) this.reject('Malformed Git index entry');
      safePath(path);
      if (this.excluded(path) || !/^100(?:644|755)$/.test(mode)) this.reject('Index contains excluded or unsupported source');
      const data = this.git(root, ['cat-file', 'blob', objectId]);
      this.assertNoCredential(data);
      return { path, mode, oid: objectId, stage: Number(stage), data: data.toString('base64') };
    });
    const refs = this.readRefs(root);
    if (refs.some(ref => ref.name.startsWith('refs/replace/'))) this.reject('Replacement object refs are unsupported');
    const objects = this.git(root,['cat-file','--batch-all-objects','--batch-check=%(objectname) %(objecttype)']).toString().trim().split('\n');
    if (objects.length > this.policy.maxFiles) this.reject('Git object count exceeds policy');
    const reachable = new Set(this.git(root,['rev-list','--all','HEAD']).toString().trim().split('\n'));
    const recovery = objects.filter(object => object.endsWith(' commit')).map(object => object.split(' ')[0])
      .filter((objectId): objectId is string => objectId !== undefined && !reachable.has(objectId));
    const history = this.git(root, ['rev-list', '--objects', '--all', 'HEAD', ...recovery]).toString().trim().split('\n');
    if (history.length > this.policy.maxFiles) this.reject('Git object count exceeds policy');
    let inspectedBytes = 0;
    for (const entry of history) {
      const split = entry.indexOf(' ');
      const objectId = split < 0 ? entry : entry.slice(0,split);
      const path = split < 0 ? '' : entry.slice(split+1);
      if (path && this.excluded(path)) this.reject('History contains an excluded credential path');
      if (this.git(root, ['cat-file', '-t', objectId]).toString().trim() === 'blob') {
        const blob = this.git(root, ['cat-file', 'blob', objectId]);
        inspectedBytes += blob.length;
        if (inspectedBytes > this.policy.maxExpandedBytes) this.reject('History exceeds preservation policy');
        this.assertNoCredential(blob);
      }
    }
    const directory = mkdtempSync(join(this.policy.scratchDirectory, 'capture-'));
    try {
      const bundlePath = join(directory, 'history.bundle');
      this.git(root, ['bundle', 'create', bundlePath, '--all', 'HEAD', ...recovery]);
      const bundle = readFileSync(bundlePath);
      const head = this.git(root, ['rev-parse', '--verify', 'HEAD']).toString().trim();
      let headRef: string | null = null;
      try { headRef = this.git(root, ['symbolic-ref', '-q', 'HEAD']).toString().trim(); } catch { /* detached HEAD */ }
      const manifest: SourceManifest = {
        version: 1, head, headRef, refs: [...refs,...recovery.map(objectId => ({ name: `refs/agent-crew/recovery/${objectId}`, oid: objectId }))]
          .sort((a,b) => a.name.localeCompare(b.name)), bundle: bundle.toString('base64'), bundleHash: sourceHash(bundle), index,
        files: files.map(path => {
          const data = readFileSync(join(root,path));
          this.assertNoCredential(data);
          return { path, mode: lstatSync(join(root,path)).mode & 0o777, data: data.toString('base64'), sha256: sourceHash(data) };
        }),
      };
      const encoded = Buffer.from(JSON.stringify(manifest));
      if (encoded.length > this.policy.maxExpandedBytes) this.reject('Expanded archive exceeds policy');
      const bytes = gzipSync(encoded);
      if (bytes.length > this.policy.maxArchiveBytes) this.reject('Archive exceeds policy');
      // Verify workspace did not change across capture. Callers must quiesce writers;
      // this check catches ordinary races, not a malicious filesystem actor.
      if (this.git(root, ['rev-parse', '--verify', 'HEAD']).toString().trim() !== head ||
          JSON.stringify(this.readRefs(root)) !== JSON.stringify(refs) ||
          this.git(root, ['ls-files', '--stage', '-z']).toString() !== entries.join('\0') + (entries.length ? '\0' : '') ||
          this.walk(root).filter(path => path !== '.git' && !path.startsWith('.git/')).join('\0') !== files.join('\0') ||
          manifest.files.some(file => sourceHash(readFileSync(join(root,file.path))) !== file.sha256)) this.reject('Workspace changed during capture');
      return { bytes, sha256: sourceHash(bytes), head, manifestVersion: 1 };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  verify(bytes: Buffer, expectedHash: string): SourceManifest {
    if (bytes.length > this.policy.maxArchiveBytes || sourceHash(bytes) !== expectedHash) this.reject('Archive hash mismatch');
    const manifest = manifestSchema.parse(JSON.parse(gunzipSync(bytes, { maxOutputLength: this.policy.maxExpandedBytes }).toString()));
    if (manifest.files.length + manifest.index.length > this.policy.maxFiles) this.reject('Archive file count exceeds policy');
    if (sourceHash(Buffer.from(manifest.bundle,'base64')) !== manifest.bundleHash) this.reject('Git bundle hash mismatch');
    const paths = new Set<string>();
    for (const file of manifest.files) {
      safePath(file.path);
      if (paths.has(file.path) || this.excluded(file.path) || file.path.split('/').some(part => part.toLowerCase() === '.git')) this.reject('Unsafe archive path');
      paths.add(file.path);
      const data = Buffer.from(file.data,'base64');
      if (sourceHash(data) !== file.sha256) this.reject('Invalid archive file');
      this.assertNoCredential(data);
    }
    for (const file of manifest.index) {
      safePath(file.path);
      if (this.excluded(file.path) || file.path.split('/').some(part => part.toLowerCase() === '.git')) this.reject('Unsafe index path');
      this.assertNoCredential(Buffer.from(file.data,'base64'));
    }
    if (manifest.headRef !== null && !manifest.headRef.startsWith('refs/heads/')) this.reject('Invalid HEAD reference');
    if (new Set(manifest.refs.map(ref => ref.name)).size !== manifest.refs.length ||
        manifest.refs.some(ref => !ref.name.startsWith('refs/') || ref.name.startsWith('refs/replace/'))) this.reject('Unsafe Git references');
    return manifest;
  }

  restore(bytes: Buffer, expectedHash: string, destination: string): SourceManifest {
    const manifest = this.verify(bytes, expectedHash);
    // Never overwrite an existing workspace, even an empty one.
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    const directory = mkdtempSync(join(this.policy.scratchDirectory, 'restore-'));
    try {
      this.git(destination, ['init', '--template=', '--initial-branch=restore', ...(manifest.head.length === 64 ? ['--object-format=sha256'] : [])]);
      const bundlePath = join(directory,'history.bundle');
      writeFileSync(bundlePath, Buffer.from(manifest.bundle,'base64'), { mode: 0o600, flag: 'wx' });
      this.git(destination, ['bundle', 'verify', bundlePath]);
      this.git(destination, ['bundle', 'unbundle', bundlePath]);
      for (const { name, oid: objectId } of manifest.refs) {
        this.git(destination, ['check-ref-format', name]);
        this.git(destination, ['update-ref', name, objectId]);
      }
      this.git(destination, ['cat-file', '-e', manifest.head + '^{commit}']);
      if (manifest.headRef) {
        this.git(destination, ['check-ref-format', manifest.headRef]);
        this.git(destination, ['symbolic-ref', 'HEAD', manifest.headRef]);
      } else this.git(destination, ['update-ref', '--no-deref', 'HEAD', manifest.head]);
      if (this.git(destination,['rev-parse','HEAD']).toString().trim() !== manifest.head) this.reject('Restored HEAD mismatch');
      let indexInfo = '';
      for (const entry of manifest.index) {
        const objectId = this.git(destination,['hash-object','-w','--stdin'], Buffer.from(entry.data,'base64')).toString().trim();
        if (objectId !== entry.oid) this.reject('Index object mismatch');
        indexInfo += entry.mode + ' ' + entry.oid + ' ' + entry.stage + '\t' + entry.path + '\0';
      }
      this.git(destination,['update-index','-z','--index-info'],Buffer.from(indexInfo));
      for (const file of manifest.files) {
        const target = join(destination,file.path);
        mkdirSync(resolve(target,'..'), { recursive: true, mode: 0o700 });
        writeFileSync(target,Buffer.from(file.data,'base64'), { flag: 'wx', mode: file.mode });
        if (sourceHash(readFileSync(target)) !== file.sha256) this.reject('Restored file mismatch');
      }
      this.git(destination,['fsck','--full','--strict']);
      if (JSON.stringify(this.readRefs(destination)) !== JSON.stringify(manifest.refs)) this.reject('Restored refs mismatch');
      return manifest;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  private git(workspace: string, args: string[], input?: Buffer): Buffer {
    try { return execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
      '-c','gc.auto=0','-c','maintenance.auto=false', ...args], {
      cwd: workspace, env: { PATH: process.env['PATH'], HOME: this.policy.scratchDirectory,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' },
      input, timeout: this.policy.gitTimeoutMs, maxBuffer: this.policy.maxExpandedBytes, stdio: ['pipe','pipe','pipe'],
    }); } catch {
      // Child-process errors can contain captured source bytes or credentials.
      throw new StateError('SOURCE_GIT_UNAVAILABLE','Trusted Git operation failed or exceeded policy');
    }
  }

  private readRefs(workspace: string): { name: string; oid: string }[] {
    return this.git(workspace,['for-each-ref','--format=%(objectname) %(refname)']).toString().trim().split('\n').filter(Boolean)
      .map(line => { const [objectId,name] = line.split(' '); if (!objectId || !name) this.reject('Invalid Git reference'); return { name, oid: objectId }; })
      .sort((a,b) => a.name.localeCompare(b.name));
  }

  private walk(root: string, prefix = ''): string[] {
    const files: string[] = [];
    for (const name of readdirSync(join(root,prefix)).sort()) {
      const path = prefix ? prefix + '/' + name : name;
      if (path === '.git' || this.excluded(path)) continue;
      if (name.toLowerCase() === '.git') this.reject('Nested Git workspaces are unsupported');
      safePath(path);
      const stat = lstatSync(join(root,path));
      if (stat.isSymbolicLink()) this.reject('Source links are unsupported');
      if (stat.isDirectory()) files.push(...this.walk(root,path));
      else if (stat.isFile()) files.push(path);
      else this.reject('Special source files are unsupported');
      if (files.length > this.policy.maxFiles) this.reject('Source file count exceeds policy');
    }
    return files;
  }

  private assertRegularTree(root: string): void {
    for (const name of readdirSync(root)) {
      const path = join(root,name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) this.reject('Unsafe Git metadata');
      if (name.endsWith('.promisor')) this.reject('Partial clone objects are unsupported');
      if (stat.isDirectory()) this.assertRegularTree(path);
    }
  }

  private excluded(path: string): boolean {
    const parts = path.split('/');
    return parts.some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|secrets|id_rsa|id_ed25519)$/i.test(part)) ||
      this.policy.excludedPaths.some(excluded => path === excluded || path.startsWith(excluded+'/'));
  }

  private assertNoCredential(data: Buffer): void {
    if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\bgh[pousr]_[A-Za-z0-9]{20,}|(?:_authToken|aws_secret_access_key)\s*[:=]/i.test(data.toString())) {
      this.reject('Credential-bearing source cannot be preserved');
    }
  }
  private exists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  private reject(reason: string): never { throw new StateError('SOURCE_ARCHIVE_UNSAFE', reason); }
}

function safePath(path: string): void {
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/') ||
      path.split('/').some(part => !part || part === '.' || part === '..') ||
      relative('/',resolve('/',path)).split(sep).includes('..')) {
    throw new StateError('SOURCE_ARCHIVE_UNSAFE', 'Unsafe relative source path');
  }
}
