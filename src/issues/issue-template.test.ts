import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AGENT_TASK_TEMPLATE_VERSION } from './issue-template.js';

const template = readFileSync(new URL('../../.github/ISSUE_TEMPLATE/agent-task.yml', import.meta.url), 'utf8');

test('the GitHub issue template identifies its version', () => {
  assert.match(template, new RegExp(`^name: Agent task \\(v${AGENT_TASK_TEMPLATE_VERSION}\\)$`, 'm'));
});

test('the GitHub issue template contains the seven required sections in order', () => {
  const sectionLabels = [...template.matchAll(/^ {6}label: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(sectionLabels, [
    'User outcome and current behavior',
    'Repository and branch contract',
    'Required behavior and edge cases',
    'Allowed scope and non-goals',
    'Acceptance and verification',
    'Execution decisions and stop conditions',
    'Delivery contract',
  ]);
  assert.equal([...template.matchAll(/^ {2}- type: textarea$/gm)].length, 7);
});
