import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from './persistent-zcode-service.js';

const { normalizeZcodeMode, handleReverseRequest, resetAll } = __testing;

test('permission mode mapping', () => {
  assert.equal(normalizeZcodeMode('default'), 'build');
  assert.equal(normalizeZcodeMode(''), 'build');
  assert.equal(normalizeZcodeMode(undefined), 'build');
  assert.equal(normalizeZcodeMode('acceptEdits'), 'edit');
  assert.equal(normalizeZcodeMode('plan'), 'plan');
  assert.equal(normalizeZcodeMode('bypassPermissions'), 'yolo');
  assert.equal(normalizeZcodeMode('yolo'), 'yolo');
});

test('requestRuntimePreferences is always answered', async () => {
  const reply = await handleReverseRequest('session/requestRuntimePreferences', { sessionId: 's' });
  assert.deepEqual(Object.keys(reply).sort(), [
    'askUserQuestionAutoResolutionEnabled',
    'memoryEnabled',
    'nativeSearchEnhancementsEnabled',
  ]);
});

test('permission request picks the server-offered allow option', async () => {
  resetAll();
  const reply = await handleReverseRequest('interaction/requestPermission', {
    sessionId: 'sx',
    requestId: 'perm_1',
    options: [
      { optionId: 'deny', response: { decision: 'deny', reason: 'no' } },
      { optionId: 'allow_once', response: { decision: 'allow', reason: 'Approved once' } },
    ],
  });
  assert.deepEqual(reply, { decision: 'allow', reason: 'Approved once' });
});

test('permission retries on the same family get the cached reply', async () => {
  resetAll();
  const params = {
    sessionId: 'sx',
    requestId: 'perm_family',
    options: [{ optionId: 'allow_once', response: { decision: 'allow', reason: 'once' } }],
  };
  const first = await handleReverseRequest('interaction/requestPermission', params);
  const second = await handleReverseRequest('interaction/requestPermission', params);
  assert.equal(second, first); // same object — no re-evaluation
});

test('browser capability degrades gracefully; unknown methods raise -32601', async () => {
  resetAll();
  assert.deepEqual(await handleReverseRequest('interaction/browserList', {}), { browsers: [] });
  assert.deepEqual(
    await handleReverseRequest('interaction/requestProviderRuntimeHeaders', {}),
    { headersApplied: false },
  );
  await assert.rejects(
    () => handleReverseRequest('interaction/browserExecute', {}),
    (err) => err.code === -32601,
  );
});

test('user input prompts are declined (no dialog wiring in v1)', async () => {
  const reply = await handleReverseRequest('interaction/requestUserInput', { toolName: 'AskUserQuestion' });
  assert.equal(reply.action, 'decline');
});
