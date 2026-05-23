import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOpenCodePermissionDialogRequest,
  mapOpenCodePermissionToToolName,
  shouldAutoAllowOpenCodePermission,
  shouldAutoRejectOpenCodePermission,
} from './opencode-permissions.js';

test('opencode permissions auto-allow read-only permissions in default mode', () => {
  assert.equal(shouldAutoAllowOpenCodePermission('read', 'default'), true);
  assert.equal(shouldAutoAllowOpenCodePermission('grep', 'default'), true);
  assert.equal(shouldAutoAllowOpenCodePermission('glob', 'default'), true);
  assert.equal(shouldAutoAllowOpenCodePermission('lsp', 'default'), true);
});

test('opencode permissions auto-allow edit only in edit modes', () => {
  assert.equal(shouldAutoAllowOpenCodePermission('edit', 'default'), false);
  assert.equal(shouldAutoAllowOpenCodePermission('edit', 'plan'), false);
  assert.equal(shouldAutoAllowOpenCodePermission('edit', 'acceptEdits'), true);
  assert.equal(shouldAutoAllowOpenCodePermission('edit', 'autoEdit'), true);
});

test('opencode permissions auto-allow all permissions in bypass mode', () => {
  assert.equal(shouldAutoAllowOpenCodePermission('bash', 'bypassPermissions'), true);
  assert.equal(shouldAutoAllowOpenCodePermission('external_directory', 'bypassPermissions'), true);
  assert.equal(shouldAutoAllowOpenCodePermission('webfetch', 'bypassPermissions'), true);
});

test('opencode permissions reject non-read operations in plan mode', () => {
  assert.equal(shouldAutoRejectOpenCodePermission('edit', 'plan'), true);
  assert.equal(shouldAutoRejectOpenCodePermission('bash', 'plan'), true);
  assert.equal(shouldAutoRejectOpenCodePermission('read', 'plan'), false);
});

test('maps opencode permissions to existing dialog tool names', () => {
  assert.equal(mapOpenCodePermissionToToolName('read'), 'Read');
  assert.equal(mapOpenCodePermissionToToolName('grep'), 'Grep');
  assert.equal(mapOpenCodePermissionToToolName('glob'), 'Glob');
  assert.equal(mapOpenCodePermissionToToolName('edit'), 'Edit');
  assert.equal(mapOpenCodePermissionToToolName('bash'), 'Bash');
  assert.equal(mapOpenCodePermissionToToolName('task'), 'Agent');
  assert.equal(mapOpenCodePermissionToToolName('unknown_tool'), 'unknown_tool');
});

test('builds edit dialog input with file and diff metadata', () => {
  const request = buildOpenCodePermissionDialogRequest({
    id: 'per_1',
    permission: 'edit',
    patterns: ['src/App.tsx'],
    always: ['*'],
    metadata: {
      filepath: '/tmp/project/src/App.tsx',
      diff: '--- old\n+++ new',
    },
  }, '/tmp/project');

  assert.equal(request.toolName, 'Edit');
  assert.equal(request.inputs.cwd, '/tmp/project');
  assert.equal(request.inputs.requestId, 'per_1');
  assert.equal(request.inputs.file_path, '/tmp/project/src/App.tsx');
  assert.equal(request.inputs.path, '/tmp/project/src/App.tsx');
  assert.equal(request.inputs.content, '--- old\n+++ new');
  assert.deepEqual(request.inputs.patterns, ['src/App.tsx']);
});

test('builds bash dialog input from permission patterns', () => {
  const request = buildOpenCodePermissionDialogRequest({
    id: 'per_2',
    permission: 'bash',
    patterns: ['npm test'],
    metadata: {},
  }, '/tmp/project');

  assert.equal(request.toolName, 'Bash');
  assert.equal(request.inputs.command, 'npm test');
  assert.equal(request.inputs.cwd, '/tmp/project');
});
