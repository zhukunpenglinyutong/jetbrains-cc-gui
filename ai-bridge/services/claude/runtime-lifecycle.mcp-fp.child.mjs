/**
 * Child process test for MCP fingerprint change scenario (P0.4).
 * Verifies acquireRuntime rebuilds runtime when MCP server config changes.
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

// Test: MCP server config change should rebuild runtime
const baseParams = {
  sessionId: '',
  runtimeSessionEpoch: 'epoch-mcp-fp',
  cwd: process.cwd(),
  message: 'hello',
};

// First request with one MCP server
const overrides1 = {
  settings: { env: { ANTHROPIC_API_KEY: 'sk-test' } }
};

const ctx1 = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6' }, false, overrides1
);
const runtime1 = await __testing.acquireRuntime(ctx1);
const sig1 = runtime1.runtimeSignature;
console.log('FIRST_RUNTIME_SIGNATURE=' + sig1);

// Acquire again with same config - should reuse
const runtime1Again = await __testing.acquireRuntime(ctx1);
assert.equal(runtime1Again, runtime1, 'same MCP config must reuse the runtime');
assert.equal(created, 1);

// Second request with ADDITIONAL MCP server
const overrides2 = {
  settings: { env: { ANTHROPIC_API_KEY: 'sk-test' } },
  mcpServers: {
    'new-server': { command: 'new-mcp', args: ['--arg'] }
  }
};

const ctx2 = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6' }, false, overrides2
);
const runtime2 = await __testing.acquireRuntime(ctx2);
const sig2 = runtime2.runtimeSignature;
console.log('SECOND_RUNTIME_SIGNATURE=' + sig2);

// Runtime should be rebuilt because MCP fingerprint changed
assert.notEqual(runtime2, runtime1, 'different MCP config must rebuild the runtime');
assert.notEqual(sig2, sig1, 'runtime signature must differ when MCP config changes');
assert.equal(created, 2, 'should create new runtime for different MCP config');

// Verify the MCP fingerprint actually differs
const parsed1 = JSON.parse(sig1);
const parsed2 = JSON.parse(sig2);
assert.notEqual(parsed1.mcpFingerprint, parsed2.mcpFingerprint, 'mcpFingerprint must differ');

console.log('SCENARIO_OK');
await __testing.resetState();
process.exit(0);