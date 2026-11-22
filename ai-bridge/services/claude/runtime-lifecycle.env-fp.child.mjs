/**
 * Child process test for env fingerprint change scenario (P0.4).
 * Verifies acquireRuntime rebuilds runtime when env fingerprint changes.
 */

import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';

/**
 * Create a fake SDK query whose message iterator is a REAL native async
 * generator, mirroring the SDK's readSdkMessages(). It pends until close()
 * is called (the real iterator stays open between turns), so the perpetual
 * reader neither spins nor tears the runtime down mid-test.
 */
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

// Test: env fingerprint change (ANTHROPIC_API_KEY rotation) should rebuild runtime
// The fingerprintEnv reads from options.env which comes from buildCliEnv() (process.env)
// setupApiKey() reads from settings.env, so we pass the API key via overrides.settings.env

const baseParams = {
  sessionId: 'test-session-env-fp',
  runtimeSessionEpoch: 'epoch-env-fp',
  cwd: process.cwd(),
  message: 'hello',
};

// First request with original API key in settings
const overrides1 = {
  settings: {
    env: { ANTHROPIC_API_KEY: 'sk-old-key-12345' }
  }
};

const ctx1 = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6' }, false, overrides1
);
console.log('CTX1 options.env.ANTHROPIC_API_KEY:', ctx1.options.env.ANTHROPIC_API_KEY);
console.log('CTX1 runtimeSignature:', ctx1.runtimeSignature);
console.log('CTX1 envFingerprint:', JSON.parse(ctx1.runtimeSignature).envFingerprint);
const runtime1 = await __testing.acquireRuntime(ctx1);
const sig1 = runtime1.runtimeSignature;
console.log('FIRST_RUNTIME_SIGNATURE=' + sig1);
console.log('FIRST_RUNTIME_ID=' + runtime1.createdAt);

// Acquire again with same env - should reuse
const runtime1Again = await __testing.acquireRuntime(ctx1);
assert.equal(runtime1Again, runtime1, 'same env must reuse the runtime');
assert.equal(created, 1, 'should not create new runtime for identical env');
console.log('RUNTIME1AGAIN same as runtime1:', runtime1Again === runtime1);

// Second request with DIFFERENT API key (simulating .env rotation)
const overrides2 = {
  settings: {
    env: { ANTHROPIC_API_KEY: 'sk-new-key-67890' }
  }
};

const ctx2 = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6' }, false, overrides2
);
console.log('CTX2 options.env.ANTHROPIC_API_KEY:', ctx2.options.env.ANTHROPIC_API_KEY);
console.log('CTX2 runtimeSignature:', ctx2.runtimeSignature);
console.log('CTX2 envFingerprint:', JSON.parse(ctx2.runtimeSignature).envFingerprint);
const runtime2 = await __testing.acquireRuntime(ctx2);
const sig2 = runtime2.runtimeSignature;
console.log('SECOND_RUNTIME_SIGNATURE=' + sig2);
console.log('SECOND_RUNTIME_ID=' + runtime2.createdAt);

// Debug: print both runtime signatures
console.log('runtime1.runtimeSignature:', runtime1.runtimeSignature);
console.log('runtime2.runtimeSignature:', runtime2.runtimeSignature);
console.log('runtime1 === runtime2:', runtime1 === runtime2);

// Runtime should be rebuilt because env fingerprint changed
assert.notEqual(runtime2, runtime1, 'different env (API key) must rebuild the runtime');
assert.notEqual(sig2, sig1, 'runtime signature must differ when env changes');
assert.equal(created, 2, 'should create new runtime for different env');

// Verify the env fingerprint actually differs in the signature
const parsed1 = JSON.parse(sig1);
const parsed2 = JSON.parse(sig2);
assert.notEqual(parsed1.envFingerprint, parsed2.envFingerprint, 'envFingerprint must differ');

console.log('SCENARIO_OK');
await __testing.resetState();
process.exit(0);