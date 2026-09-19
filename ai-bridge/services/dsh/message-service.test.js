import test from 'node:test';
import assert from 'node:assert/strict';

import { bindWorkspaceSession, splitModelTuple } from './message-service.js';
import { buildPromptContent } from './session.js';

test('splitModelTuple splits "<provider>/<model>" tuples', () => {
  assert.deepEqual(splitModelTuple('openai/gpt-5'), { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(splitModelTuple('openrouter/a/b'), { provider: 'openrouter', model: 'a/b' });
});

test('splitModelTuple maps empty and sentinel values to host default', () => {
  assert.equal(splitModelTuple(''), null);
  assert.equal(splitModelTuple(null), null);
  assert.equal(splitModelTuple(undefined), null);
  assert.equal(splitModelTuple('   '), null);
  assert.equal(splitModelTuple('auto'), null);
  assert.equal(splitModelTuple('default'), null);
  assert.equal(splitModelTuple('dsh-default'), null);
});

test('splitModelTuple keeps a bare model with an empty provider', () => {
  assert.deepEqual(splitModelTuple('gpt-5'), { provider: '', model: 'gpt-5' });
  assert.deepEqual(splitModelTuple('provider/'), { provider: 'provider', model: '' });
});

test('buildPromptContent attaches image name only when non-empty', () => {
  // Host Zod is `name?: string` ($strip) — `name: null` is rejected.
  const content = buildPromptContent('hi', [
    { mediaType: 'image/jpeg', data: 'AAAA', name: 'shot.jpg' },
    { mediaType: 'image/png', data: 'BBBB', name: null },
    { mediaType: 'image/png', data: 'CCCC', name: '   ' },
  ]);
  assert.deepEqual(content[0], { type: 'text', text: 'hi' });
  assert.equal(content[1].name, 'shot.jpg');
  assert.ok(!('name' in content[2]), 'name: null must be stripped');
  assert.ok(!('name' in content[3]), 'blank name must be stripped');
});

test('buildPromptContent skips image parts without data and defaults mediaType', () => {
  const content = buildPromptContent('x', [
    { mediaType: 'image/png' },
    { data: 'AAAA' },
    null,
  ]);
  assert.equal(content.length, 2);
  assert.deepEqual(content[1], { type: 'image', mediaType: 'image/png', data: 'AAAA' });
});

/** Minimal host double: records the RPCs the workspace/session binding makes. */
function stubHost(responses = {}) {
  const calls = [];
  return {
    calls,
    async call(method, payload) {
      calls.push({ method, payload });
      const response = responses[method];
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  };
}

test('bindWorkspaceSession binds a new session to its project workspace', async () => {
  const client = stubHost({
    'workspace.create': { workspace: { workspaceId: 'w1' } },
    'session.create': { sessionId: 's1' },
  });
  assert.equal(await bindWorkspaceSession(client, 'D:/proj'), 's1');
  assert.deepEqual(client.calls, [
    { method: 'workspace.create', payload: { path: 'D:/proj' } },
    { method: 'session.create', payload: { workspaceId: 'w1' } },
  ]);
});

test('bindWorkspaceSession re-binds a resumed thread into the workspace', async () => {
  const client = stubHost({
    'workspace.create': { workspace: { workspaceId: 'w1' } },
    'session.create': { sessionId: 's9' },
  });
  assert.equal(await bindWorkspaceSession(client, 'D:/proj', 'dsh:s9'), 's9');
  assert.deepEqual(client.calls, [
    { method: 'workspace.create', payload: { path: 'D:/proj' } },
    { method: 'session.create', payload: { workspaceId: 'w1', sessionId: 's9' } },
  ]);
});

test('a refused re-bind never fails the turn', async () => {
  const client = stubHost({
    'workspace.create': { workspace: { workspaceId: 'w1' } },
    'session.create': new Error('session/conflict: cwd differs'),
  });
  assert.equal(await bindWorkspaceSession(client, 'D:/proj', 's9'), 's9');
});

test('a failed workspace binding is loud and keeps its message', async () => {
  const unreachable = stubHost({ 'workspace.create': new Error('boom') });
  await assert.rejects(
    () => bindWorkspaceSession(unreachable, 'D:/proj'),
    /dsh workspace\.create failed: boom/
  );

  const noId = stubHost({ 'workspace.create': { workspace: {} } });
  await assert.rejects(
    () => bindWorkspaceSession(noId, 'D:/proj'),
    /dsh workspace\.create failed: dsh workspace\.create missing workspaceId/
  );
});

test('a new session the host refuses is loud', async () => {
  const client = stubHost({
    'workspace.create': { workspace: { workspaceId: 'w1' } },
    'session.create': new Error('nope'),
  });
  await assert.rejects(
    () => bindWorkspaceSession(client, 'D:/proj'),
    /dsh session\.create failed: nope/
  );
});
