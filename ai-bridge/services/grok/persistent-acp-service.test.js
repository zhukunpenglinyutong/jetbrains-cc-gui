/**
 * Tests for Grok persistent ACP service: runtime keys, live permission mode,
 * default-mode normalization (preconnect "" ↔ UI "default").
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __testing,
  setPermissionModePersistent,
} from './persistent-acp-service.js';

const {
  makeRuntimeKey,
  normalizePermissionMode,
  resetRegistry,
  getRuntimes,
  createTestRuntime,
  forceSetActiveTurn,
  getActiveTurnRuntimeInternal,
} = __testing;

// ---------------------------------------------------------------------------
// normalizePermissionMode / makeRuntimeKey
// ---------------------------------------------------------------------------

test('normalizePermissionMode maps empty/null to default', () => {
  assert.equal(normalizePermissionMode(''), 'default');
  assert.equal(normalizePermissionMode(null), 'default');
  assert.equal(normalizePermissionMode(undefined), 'default');
  assert.equal(normalizePermissionMode('  '), 'default');
  assert.equal(normalizePermissionMode('default'), 'default');
  assert.equal(normalizePermissionMode('bypassPermissions'), 'bypasspermissions');
});

test('makeRuntimeKey is stable for same inputs', () => {
  const k1 = makeRuntimeKey({
    runtimeSessionEpoch: 'e1',
    sessionId: 's1',
    cwd: '/tmp/foo',
    model: 'grok-beta',
    permissionMode: 'default',
    apiKey: '',
  });
  const k2 = makeRuntimeKey({
    runtimeSessionEpoch: 'e1',
    sessionId: 's1',
    cwd: '/tmp/foo',
    model: 'grok-beta',
    permissionMode: 'default',
    apiKey: '',
  });
  assert.equal(k1, k2);
});

test('makeRuntimeKey treats empty permissionMode as default (preconnect ↔ UI)', () => {
  const kEmpty = makeRuntimeKey({
    runtimeSessionEpoch: 'e1',
    sessionId: 's1',
    cwd: '/tmp',
    model: 'm',
    permissionMode: '',
  });
  const kDefault = makeRuntimeKey({
    runtimeSessionEpoch: 'e1',
    sessionId: 's1',
    cwd: '/tmp',
    model: 'm',
    permissionMode: 'default',
  });
  assert.equal(
    kEmpty,
    kDefault,
    'preconnect with "" must share runtime key with UI default mode'
  );
});

test('makeRuntimeKey differs when epoch changes', () => {
  const k1 = makeRuntimeKey({ runtimeSessionEpoch: 'e1', sessionId: '', cwd: '/tmp', model: '', permissionMode: '' });
  const k2 = makeRuntimeKey({ runtimeSessionEpoch: 'e2', sessionId: '', cwd: '/tmp', model: '', permissionMode: '' });
  assert.notEqual(k1, k2);
});

test('makeRuntimeKey differs when permissionMode changes (default vs bypass)', () => {
  const k1 = makeRuntimeKey({ runtimeSessionEpoch: 'e1', sessionId: '', cwd: '/tmp', model: '', permissionMode: 'default' });
  const k2 = makeRuntimeKey({ runtimeSessionEpoch: 'e1', sessionId: '', cwd: '/tmp', model: '', permissionMode: 'bypassPermissions' });
  assert.notEqual(k1, k2);
});

test('makeRuntimeKey includes auth fingerprint (key vs oauth)', () => {
  const withKey = makeRuntimeKey({ runtimeSessionEpoch: 'e', sessionId: '', cwd: '/tmp', model: '', permissionMode: '', apiKey: 'secret' });
  const withoutKey = makeRuntimeKey({ runtimeSessionEpoch: 'e', sessionId: '', cwd: '/tmp', model: '', permissionMode: '' });
  assert.notEqual(withKey, withoutKey);
});

// ---------------------------------------------------------------------------
// Registry + setPermissionModePersistent (live mode — silence fix)
// ---------------------------------------------------------------------------

test('registry starts empty after reset', () => {
  resetRegistry();
  assert.equal(getRuntimes().length, 0);
});

test('createTestRuntime registers with default mode and live holder', () => {
  resetRegistry();
  const rt = createTestRuntime('k1', { permissionMode: '' });
  assert.equal(rt.permissionMode, 'default');
  assert.ok(rt._livePermission);
  assert.equal(rt._livePermission.permissionMode, 'default');
  assert.equal(getRuntimes().length, 1);
});

test('setPermissionModePersistent updates live holder used by permission handlers', async () => {
  resetRegistry();
  const prompts = [];
  const rt = createTestRuntime('key1', {
    sessionId: 'sess-live',
    permissionMode: 'default',
    clientRequest: async (method, params) => {
      prompts.push({ method, params });
      return {};
    },
  });
  // Wire client.request from clientRequest helper
  rt.client.request = rt.client.request || (async (m, p) => {
    prompts.push({ method: m, params: p });
    return {};
  });
  // createTestRuntime puts clientRequest on opts.clientRequest — re-bind properly
  const captured = [];
  rt.client = {
    activeSessionId: 'sess-live',
    request: async (method, params) => {
      captured.push({ method, params });
      return {};
    },
  };
  forceSetActiveTurn(rt);

  const result = await setPermissionModePersistent({
    sessionId: 'sess-live',
    permissionMode: 'bypassPermissions',
  });

  assert.equal(result.applied, true);
  assert.equal(result.permissionMode, 'bypasspermissions');
  assert.equal(rt.permissionMode, 'bypasspermissions');
  assert.equal(
    rt._livePermission.permissionMode,
    'bypasspermissions',
    'live holder must update so authorizeCreate/onServerRequest re-read new mode'
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].params.prompt[0].text, '/always-approve on');
});

test('setPermissionModePersistent switching back to default turns always-approve off', async () => {
  resetRegistry();
  const captured = [];
  const rt = createTestRuntime('key-switch', {
    sessionId: 'sess-sw',
    permissionMode: 'bypassPermissions',
  });
  rt.client = {
    activeSessionId: 'sess-sw',
    request: async (method, params) => {
      captured.push(params.prompt[0].text);
      return {};
    },
  };
  forceSetActiveTurn(rt);

  await setPermissionModePersistent({
    sessionId: 'sess-sw',
    permissionMode: 'default',
  });

  assert.equal(rt._livePermission.permissionMode, 'default');
  assert.equal(captured[0], '/always-approve off');
});

test('setPermissionModePersistent without runtime is applied=false (no throw)', async () => {
  resetRegistry();
  const result = await setPermissionModePersistent({
    sessionId: 'missing',
    permissionMode: 'default',
  });
  assert.equal(result.success, true);
  assert.equal(result.applied, false);
});

test('setPermissionModePersistent updates active turn even when sessionId mismatches', async () => {
  // Regression: Java may pass permission-service / host session id while the Grok
  // runtime stores the ACP thread id. Live Auto switch must still hit the active turn.
  resetRegistry();
  const captured = [];
  const rt = createTestRuntime('key-active', {
    sessionId: 'acp-thread-xyz',
    permissionMode: 'default',
  });
  rt.client = {
    activeSessionId: 'acp-thread-xyz',
    request: async (_m, params) => {
      captured.push(params.prompt[0].text);
      return {};
    },
  };
  forceSetActiveTurn(rt);

  const result = await setPermissionModePersistent({
    sessionId: 'host-permission-uuid-different',
    permissionMode: 'bypassPermissions',
  });

  assert.equal(result.applied, true);
  assert.equal(rt._livePermission.permissionMode, 'bypasspermissions');
  assert.equal(captured[0], '/always-approve on');
});

test('setPermissionModePersistent updates all runtimes in the same epoch', async () => {
  resetRegistry();
  const rtA = createTestRuntime('key-a', {
    sessionId: 'a',
    epoch: 'ep-shared',
    permissionMode: 'default',
  });
  const rtB = createTestRuntime('key-b', {
    sessionId: 'b',
    epoch: 'ep-shared',
    permissionMode: 'default',
  });
  const rtOther = createTestRuntime('key-other', {
    sessionId: 'c',
    epoch: 'ep-other',
    permissionMode: 'default',
  });
  rtA.client = { activeSessionId: 'a', request: async () => ({}) };
  rtB.client = { activeSessionId: 'b', request: async () => ({}) };
  rtOther.client = { activeSessionId: 'c', request: async () => ({}) };

  await setPermissionModePersistent({
    runtimeSessionEpoch: 'ep-shared',
    permissionMode: 'bypassPermissions',
  });

  assert.equal(rtA._livePermission.permissionMode, 'bypasspermissions');
  assert.equal(rtB._livePermission.permissionMode, 'bypasspermissions');
  assert.equal(rtOther._livePermission.permissionMode, 'default');
});

test('setPermissionModePersistent only mutates active when targeting session without epoch', async () => {
  resetRegistry();
  const rtA = createTestRuntime('key-a', { sessionId: 'a', permissionMode: 'default' });
  const rtB = createTestRuntime('key-b', { sessionId: 'b', permissionMode: 'default' });
  rtA.client = { activeSessionId: 'a', request: async () => ({}) };
  rtB.client = { activeSessionId: 'b', request: async () => ({}) };
  forceSetActiveTurn(rtA);

  // Active is always updated; exact session match also updates A.
  await setPermissionModePersistent({ sessionId: 'a', permissionMode: 'bypassPermissions' });

  assert.equal(rtA._livePermission.permissionMode, 'bypasspermissions');
  assert.equal(rtB._livePermission.permissionMode, 'default');
});

test('live holder change is visible to decision-style re-read (simulates authorizeCreate)', () => {
  resetRegistry();
  const rt = createTestRuntime('auth-gate', { permissionMode: 'default' });
  // Simulate what authorizeCreate does: re-read live.permissionMode every call
  const shouldAuto = () => {
    const mode = rt._livePermission.permissionMode || 'default';
    return mode === 'bypasspermissions' || mode === 'yolo' || mode === 'auto';
  };
  assert.equal(shouldAuto(), false, 'default must gate tools');

  rt._livePermission.permissionMode = 'bypasspermissions';
  assert.equal(shouldAuto(), true, 'after live switch to bypass, gate opens');

  rt._livePermission.permissionMode = 'default';
  assert.equal(shouldAuto(), false, 'switch back to default must gate again');
});

test('forceSetActiveTurn tracks active runtime', () => {
  resetRegistry();
  const rt = createTestRuntime('active', { permissionMode: 'default' });
  forceSetActiveTurn(rt);
  assert.equal(getActiveTurnRuntimeInternal(), rt);
  forceSetActiveTurn(null);
  assert.equal(getActiveTurnRuntimeInternal(), null);
});
