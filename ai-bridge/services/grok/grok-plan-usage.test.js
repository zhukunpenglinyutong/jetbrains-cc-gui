import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlanUsagePersistent, __testing } from './persistent-acp-service.js';

const { resetRegistry, createTestRuntime } = __testing;

let tail = Promise.resolve();
function serial(name, fn) {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  });
}

const credits = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-08T00:00:00Z',
    },
  },
  subscriptionTier: 'SuperGrok',
};

serial('getPlanUsagePersistent reads _x.ai/billing from the warm agent without recycling it', async () => {
  resetRegistry();
  const calls = [];
  const client = {
    closed: false,
    isUnhealthy: () => false,
    request: async (method, params, timeout, options) => {
      calls.push({ method, params, timeout, options });
      return credits;
    },
  };
  createTestRuntime('plan-usage', { client });

  const payload = await getPlanUsagePersistent({ ephemeral: true, cwd: '/tmp' });
  assert.equal(payload.present, true);
  assert.equal(payload.capacity_pct, 42.5);
  assert.equal(payload.level, 'SuperGrok');
  assert.equal(payload.windows[0].period_type, 'USAGE_PERIOD_TYPE_WEEKLY');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, '_x.ai/billing');
  assert.deepEqual(calls[0].params, {});
  assert.equal(calls[0].options.recycleOnTimeout, false);
  resetRegistry();
});

serial('getPlanUsagePersistent stays unavailable without a runtime when ephemeral is off', async () => {
  resetRegistry();
  const payload = await getPlanUsagePersistent({ ephemeral: false });
  assert.equal(payload.present, false);
  assert.equal(payload.unavailable, true);
  assert.match(payload.message, /not running/);
  resetRegistry();
});

serial('getPlanUsagePersistent turns an ACP error into a hidden bar', async () => {
  resetRegistry();
  const client = {
    closed: false,
    isUnhealthy: () => false,
    request: async () => {
      throw new Error('Billing data requires auth with grok.com');
    },
  };
  createTestRuntime('plan-usage-denied', { client });
  const payload = await getPlanUsagePersistent({ ephemeral: true });
  assert.equal(payload.present, false);
  assert.match(payload.message, /grok.com/);
  resetRegistry();
});
