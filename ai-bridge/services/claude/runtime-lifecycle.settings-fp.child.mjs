/**
 * Child process test for settings fingerprint change scenario (P0.4).
 * Verifies acquireRuntime rebuilds runtime when settings change (maxThinkingTokens, model).
 */

import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';

function createHangingQuery({ prompt, options }) {
  let closeResolve;
  const closedSignal = new Promise((resolve) => { closeResolve = resolve; });
  async function* messages() {
    await closedSignal;
  }
  const generator = messages();
  return {
    prompt,
    options,
    closed: false,
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
    close() {
      this.closed = true;
      closeResolve();
    },
    next: () => generator.next(),
  };
}

let created = 0;
__testing.setQueryFn((args) => {
  created += 1;
  return createHangingQuery(args);
});

// Test: maxThinkingTokens change (SDK option) should rebuild runtime
// The fingerprint is based on options.maxThinkingTokens directly
// resolveThinkingTokens reads settings.maxThinkingTokens, so we override it there
const baseParams = {
  sessionId: '',
  runtimeSessionEpoch: 'epoch-settings-fp',
  cwd: process.cwd(),
  message: 'hello',
  disableThinking: false
};

// First request with maxThinkingTokens: 8000 via settings
const overrides1 = {
  settings: {
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    maxThinkingTokens: 8000,
    alwaysThinkingEnabled: true
  }
};

const ctx1 = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6' }, false, overrides1
);
const runtime1 = await __testing.acquireRuntime(ctx1);
const sig1 = runtime1.runtimeSignature;
console.log('FIRST_RUNTIME_SIGNATURE=' + sig1);

// Acquire again with same settings - should reuse
const runtime1Again = await __testing.acquireRuntime(ctx1);
assert.equal(runtime1Again, runtime1, 'same settings must reuse the runtime');
assert.equal(created, 1);

// Second request with DIFFERENT maxThinkingTokens via settings
const overrides2 = {
  settings: {
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    maxThinkingTokens: 4000,
    alwaysThinkingEnabled: true
  }
};

const ctx2 = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6' }, false, overrides2
);
const runtime2 = await __testing.acquireRuntime(ctx2);
const sig2 = runtime2.runtimeSignature;
console.log('SECOND_RUNTIME_SIGNATURE=' + sig2);

// Runtime should be rebuilt because maxThinkingTokens changed
assert.notEqual(runtime2, runtime1, 'different maxThinkingTokens must rebuild the runtime');
assert.notEqual(sig2, sig1, 'runtime signature must differ when maxThinkingTokens changes');
assert.equal(created, 2, 'should create new runtime for different maxThinkingTokens');

// Verify the maxThinkingTokens in signature actually differs (the SDK option is now in signature directly)
const parsed1 = JSON.parse(sig1);
const parsed2 = JSON.parse(sig2);
assert.notEqual(parsed1.maxThinkingTokens, parsed2.maxThinkingTokens, 'maxThinkingTokens in signature must differ');

console.log('SCENARIO_OK');
await __testing.resetState();
process.exit(0);