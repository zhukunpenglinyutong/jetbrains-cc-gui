// Child process for the "closed runtime must not be reused" scenario driven by
// persistent-query-service.test.js.
//
// Why a separate process: acquireRuntime() may call buildRequestContext()
// paths that hit setupApiKey(), which resolves credentials only from
// ~/.codemoss + ~/.claude under the real home dir. The parent spawns this
// script with HOME pointed at a temp dir carrying a CLI-login config (same
// pattern as runtime-lifecycle.1m-toggle.child.mjs). A mock SDK keeps
// createRuntime off the real SDK loader.
//
// On success prints SCENARIO_OK and exits 0; any assertion failure rejects the
// top-level await, so Node exits non-zero and the parent surfaces it.
import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';

/**
 * Create a fake SDK query whose message iterator is a REAL native async
 * generator. It pends until close() is called (the real iterator stays open
 * between turns), so the perpetual reader neither spins nor tears the runtime
 * down mid-test.
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

const baseParams = {
  sessionId: '',
  runtimeSessionEpoch: 'epoch-closed-runtime',
  cwd: process.cwd(),
  message: 'hello',
};
// Settings override keeps the resolved model deterministic regardless of the
// developer's real ~/.claude/settings.json.
const overrides = { settings: { env: {} } };

const ctx = await __testing.buildRequestContext(
  { ...baseParams, model: 'claude-sonnet-4-6' }, false, overrides
);
const first = await __testing.acquireRuntime(ctx);
assert.equal(created, 1);

// Simulate the abort's disposeRuntime window: the runtime is closed but still
// registered (removeRuntime runs only after the async query.close() that is
// still in flight), and the abort left its flag set.
first.closed = true;
first.abortRequested = true;

const second = await __testing.acquireRuntime(ctx);
assert.notEqual(second, first, 'closed runtime must not be reused');
assert.equal(second.closed, false, 'replacement runtime must be alive');
assert.equal(created, 2, 'a fresh runtime must be created');

await __testing.resetState();
console.log('SCENARIO_OK');
