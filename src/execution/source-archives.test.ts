import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { SourceArchives, sourceHash } from './source-archives.js';

function git(directory: string, ...args: string[]): string {
  return execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid',...args],
    { cwd: directory, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'agent-crew-archive-'));
  const workspace = join(root,'workspace');
  mkdirSync(workspace);
  git(workspace,'init','--template=','--initial-branch=task');
  writeFileSync(join(workspace,'file.txt'),'base\n');
  git(workspace,'add','file.txt'); git(workspace,'commit','-m','base');
  const archives = new SourceArchives({ scratchDirectory: join(root,'scratch'), maxArchiveBytes: 1000000,
    maxExpandedBytes: 4000000, maxFiles: 1000, gitTimeoutMs: 5000, excludedPaths: ['node_modules'] });
  return { root, workspace, archives, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('standalone archive restores commits, index, dirty files and untracked files without original workspace', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace,'file.txt'),'local commit\n');
    git(f.workspace,'add','.'); git(f.workspace,'commit','-m','local');
    writeFileSync(join(f.workspace,'file.txt'),'staged\n'); git(f.workspace,'add','file.txt');
    writeFileSync(join(f.workspace,'file.txt'),'unstaged\n');
    writeFileSync(join(f.workspace,'new.txt'),'untracked\n');
    writeFileSync(join(f.workspace,'.env'),'SECRET=exclude-me');
    const head = git(f.workspace,'rev-parse','HEAD').trim();
    const status = git(f.workspace,'status','--porcelain','--untracked-files=all').split('\n').filter(line => !line.includes('.env')).join('\n');
    const captured = f.archives.capture(f.workspace);
    rmSync(f.workspace,{ recursive: true });
    const restored = join(f.root,'restored');
    f.archives.restore(captured.bytes,captured.sha256,restored);
    assert.equal(git(restored,'rev-parse','HEAD').trim(),head);
    assert.equal(git(restored,'show',':file.txt'),'staged\n');
    assert.equal(readFileSync(join(restored,'file.txt'),'utf8'),'unstaged\n');
    assert.equal(readFileSync(join(restored,'new.txt'),'utf8'),'untracked\n');
    assert.equal(git(restored,'rev-list','--count','HEAD').trim(),'2');
    assert.equal(git(restored,'status','--porcelain','--untracked-files=all'),status);
    assert.throws(() => f.archives.restore(captured.bytes,captured.sha256,restored), { code: 'EEXIST' });
  } finally { f.close(); }
});

test('rejects corruption, unsafe paths, links and tracked credentials without executing hooks', () => {
  const f = fixture();
  try {
    const captured = f.archives.capture(f.workspace);
    const manifest = f.archives.verify(captured.bytes,captured.sha256);
    const tampered = gzipSync(Buffer.from(JSON.stringify({ ...manifest, files: [
      { path: '../escaped', mode: 420, data: '', sha256: sourceHash(Buffer.alloc(0)) },
    ] })));
    assert.throws(() => f.archives.restore(tampered,sourceHash(tampered),join(f.root,'bad')), { code: 'SOURCE_ARCHIVE_UNSAFE' });
    assert.throws(() => f.archives.verify(Buffer.from('corrupt'),captured.sha256), { code: 'SOURCE_ARCHIVE_UNSAFE' });
    mkdirSync(join(f.workspace,'.git','hooks'),{ recursive: true });
    writeFileSync(join(f.workspace,'.git','hooks','pre-commit'),'#!/bin/sh\ntouch SHOULD_NOT_RUN\n',{ mode: 0o755 });
    f.archives.capture(f.workspace);
    symlinkSync('/etc/passwd',join(f.workspace,'unsafe-link'));
    assert.throws(() => f.archives.capture(f.workspace), { code: 'SOURCE_ARCHIVE_UNSAFE' });
    rmSync(join(f.workspace,'unsafe-link'));
    writeFileSync(join(f.workspace,'.env'),'SECRET=tracked');
    git(f.workspace,'add','.env');
    assert.throws(() => f.archives.capture(f.workspace), { code: 'SOURCE_ARCHIVE_UNSAFE' });
  } finally { f.close(); }
});

test('rejects credentials retained only in Git history and external object dependencies', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace,'secret.txt'),'-----BEGIN PRIVATE KEY-----');
    git(f.workspace,'add','.'); git(f.workspace,'commit','-m','credential');
    git(f.workspace,'rm','secret.txt'); git(f.workspace,'commit','-m','remove');
    assert.throws(() => f.archives.capture(f.workspace), { code: 'SOURCE_ARCHIVE_UNSAFE' });
    writeFileSync(join(f.workspace,'.git','objects','info','alternates'),'/outside/objects');
    assert.throws(() => f.archives.capture(f.workspace), { code: 'SOURCE_ARCHIVE_UNSAFE' });
  } finally { f.close(); }
});

test('retains local commits that are no longer reachable from the current branch',() => {
  const f = fixture();
  try {
    const base = git(f.workspace,'rev-parse','HEAD').trim();
    writeFileSync(join(f.workspace,'file.txt'),'unfinished local commit\n');
    git(f.workspace,'add','.'); git(f.workspace,'commit','-m','unfinished');
    const unfinished = git(f.workspace,'rev-parse','HEAD').trim();
    git(f.workspace,'reset','--hard',base);
    const archive = f.archives.capture(f.workspace);
    rmSync(f.workspace,{ recursive: true });
    const restored = join(f.root,'recovered');
    f.archives.restore(archive.bytes,archive.sha256,restored);
    assert.equal(git(restored,'rev-parse',`refs/agent-crew/recovery/${unfinished}`).trim(),unfinished);
    assert.equal(git(restored,'rev-parse','HEAD').trim(),base);
  } finally { f.close(); }
});

test('rejects a workspace file exceeding the expanded archive policy',() => {
  const f = fixture();
  try {
    const largeFile = join(f.workspace,'large.bin');
    writeFileSync(largeFile,'');
    truncateSync(largeFile,5_000_000);
    const bounded = new SourceArchives({ scratchDirectory: join(f.root,'bounded-scratch'), maxArchiveBytes: 1000000,
      maxExpandedBytes: 4000000, maxFiles: 1000, gitTimeoutMs: 5000, excludedPaths: [] });
    assert.throws(() => bounded.capture(f.workspace), { code: 'SOURCE_ARCHIVE_UNSAFE' });
  } finally { f.close(); }
});
