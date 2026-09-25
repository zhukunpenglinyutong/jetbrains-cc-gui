import test from 'node:test';
import assert from 'node:assert/strict';
import { billingToCapacity } from './grok-billing.js';

const WEEKLY = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-08T00:00:00Z',
    },
  },
  subscriptionTier: 'SuperGrok',
  onDemandEnabled: true,
};

test('billingToCapacity maps the credits config to one window', () => {
  const out = billingToCapacity(WEEKLY);
  assert.equal(out.present, true);
  assert.equal(out.provider, 'grok');
  assert.equal(out.source, 'x.ai/billing');
  assert.equal(out.capacity_pct, 42.5);
  assert.equal(out.level, 'SuperGrok');
  assert.equal(out.period_type, 'USAGE_PERIOD_TYPE_WEEKLY');
  assert.equal(out.reset_at, '2026-06-08T00:00:00Z');
  assert.equal(out.period_start, '2026-06-01T00:00:00Z');
  assert.equal(out.windows.length, 1);
  assert.equal(out.windows[0].id, 'USAGE_PERIOD_TYPE_WEEKLY');
  assert.equal(out.windows[0].used_pct, 42.5);
  assert.equal(out.windows[0].reset_at, '2026-06-08T00:00:00Z');
});

test('billingToCapacity unwraps a result envelope', () => {
  const out = billingToCapacity({ result: WEEKLY });
  assert.equal(out.present, true);
  assert.equal(out.capacity_pct, 42.5);
  assert.equal(out.level, 'SuperGrok');
});

test('billingToCapacity falls back to legacy monthly cents', () => {
  const out = billingToCapacity({
    config: {
      monthlyLimit: { val: 200 },
      used: { val: 50 },
      billingPeriodStart: '2026-06-01T00:00:00Z',
      billingPeriodEnd: '2026-07-01T00:00:00Z',
    },
    subscription_tier: 'SuperGrok Heavy',
  });
  assert.equal(out.present, true);
  assert.equal(out.capacity_pct, 25);
  assert.equal(out.level, 'SuperGrok Heavy');
  assert.equal(out.reset_at, '2026-07-01T00:00:00Z');
  assert.equal(out.period_start, '2026-06-01T00:00:00Z');
  assert.equal(out.windows[0].id, 'current');
});

test('billingToCapacity hides the bar when no percent can be derived', () => {
  const out = billingToCapacity({ config: { onDemandEnabled: false } });
  assert.equal(out.present, false);
  assert.equal(out.unavailable, true);
  assert.match(out.message, /creditUsagePercent/);
});

test('billingToCapacity rejects a non-object', () => {
  const out = billingToCapacity(null);
  assert.equal(out.present, false);
  assert.match(out.message, /invalid/);
});
