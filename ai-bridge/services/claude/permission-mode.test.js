import test from 'node:test';
import assert from 'node:assert/strict';

import { createPreToolUseHook } from './permission-mode.js';

function makeHook(mode = 'default', cwd = '/tmp/test-cwd') {
  return createPreToolUseHook({ value: mode }, cwd);
}

test('default mode: Bash yields "continue" so SDK can evaluate settings.json rules', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'Bash',
    tool_input: { command: 'rm something.txt' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('default mode: Read yields "continue" so deny rules like Read(./.env) can fire', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/test-cwd/.env' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('default mode: Grep yields "continue"', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'Grep',
    tool_input: { pattern: 'foo' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('bypassPermissions mode: Bash yields "continue" (SDK mode-check auto-allows)', async () => {
  const hook = makeHook('bypassPermissions');
  const result = await hook({
    tool_name: 'Bash',
    tool_input: { command: 'date' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('acceptEdits mode: Edit inside CWD yields "continue" (SDK mode-check auto-accepts)', async () => {
  const cwd = '/tmp/test-cwd';
  const hook = makeHook('acceptEdits', cwd);
  const result = await hook({
    tool_name: 'Edit',
    tool_input: { file_path: `${cwd}/src/file.js`, old_string: 'a', new_string: 'b' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('acceptEdits mode: Edit outside CWD yields "continue"', async () => {
  const hook = makeHook('acceptEdits', '/tmp/test-cwd');
  const result = await hook({
    tool_name: 'Edit',
    tool_input: { file_path: '/etc/passwd', old_string: 'a', new_string: 'b' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('default mode: MCP tool yields "continue"', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'mcp__some-server__some-tool',
    tool_input: { foo: 'bar' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('EnterPlanMode is still auto-allowed (mode transition signal)', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'EnterPlanMode',
    tool_input: {},
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'allow');
});

test('plan mode: SAFE tool (Read) yields "continue" so deny rules apply in plan mode', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/test-cwd/x' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('plan mode: PLAN_MODE_ALLOWED_TOOLS (WebFetch) yields "continue"', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com', prompt: 'title' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('plan mode: read-only MCP tool yields "continue"', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'mcp__some-server__lookup',
    tool_input: { query: 'x' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'continue');
});

test('plan mode: Agent is still auto-allowed (sub-agent permission flow unchanged)', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'Agent',
    tool_input: { description: 'x', prompt: 'y' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'allow');
});

test('plan mode: non-allowed tool falls through to plan-specific deny', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'SomeUnknownTool',
    tool_input: {},
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'deny');
});
