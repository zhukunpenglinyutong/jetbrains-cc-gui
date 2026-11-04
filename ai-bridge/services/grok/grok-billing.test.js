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
  assert.equal(out.windows[0].id, 'monthly');
});

test('billingToCapacity maps monthly currentPeriod type', () => {
  const out = billingToCapacity({
    config: {
      creditUsagePercent: 15,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_MONTHLY',
        start: '2026-06-01T00:00:00Z',
        end: '2026-07-01T00:00:00Z',
      },
    },
    subscriptionTier: 'SuperGrok',
  });
  assert.equal(out.present, true);
  assert.equal(out.capacity_pct, 15);
  assert.equal(out.period_type, 'USAGE_PERIOD_TYPE_MONTHLY');
  assert.equal(out.windows[0].id, 'USAGE_PERIOD_TYPE_MONTHLY');
});

test('billingToCapacity shows 0% when a new period omits creditUsagePercent', () => {
  const out = billingToCapacity({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-10-02T09:22:05Z',
        end: '2026-10-09T09:22:05Z',
      },
      billingPeriodStart: '2026-10-02T09:22:05Z',
      billingPeriodEnd: '2026-10-09T09:22:05Z',
      isUnifiedBillingUser: true,
    },
    subscriptionTier: 'SuperGrok Heavy',
  });
  assert.equal(out.present, true);
  assert.equal(out.capacity_pct, 0);
  assert.equal(out.level, 'SuperGrok Heavy');
  assert.equal(out.period_type, 'USAGE_PERIOD_TYPE_WEEKLY');
  assert.equal(out.windows[0].used_pct, 0);
  assert.equal(out.reset_at, '2026-10-09T09:22:05Z');
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

test('billingToCapacity reads an empty legacy used Cent as 0%', () => {
  // proto3 JSON drops val: 0, leaving `used: {}`
  const out = billingToCapacity({ config: { monthlyLimit: { val: 1000 }, used: {} } });
  assert.equal(out.present, true);
  assert.equal(out.capacity_pct, 0);
  assert.equal(out.windows[0].id, 'monthly');

  // A Cent with an unexpected shape is unknown, not 0%
  const renamed = billingToCapacity({ config: { monthlyLimit: { val: 1000 }, used: { units: 5 } } });
  assert.equal(renamed.present, false);
});

test('billingToCapacity names the window from the period dates when currentPeriod is missing', () => {
  const weekly = billingToCapacity({
    config: {
      creditUsagePercent: 12,
      billingPeriodStart: '2026-10-02T09:22:05Z',
      billingPeriodEnd: '2026-10-09T09:22:05Z',
    },
  });
  assert.equal(weekly.windows[0].id, 'weekly');
  assert.equal(weekly.windows[0].period_type, 'weekly');

  const monthly = billingToCapacity({
    config: {
      billingPeriodStart: '2026-10-01T00:00:00Z',
      billingPeriodEnd: '2026-11-01T00:00:00Z',
    },
  });
  assert.equal(monthly.capacity_pct, 0);
  assert.equal(monthly.windows[0].id, 'monthly');

  // Unparseable dates keep the old fallback instead of guessing
  const unknown = billingToCapacity({ config: { creditUsagePercent: 5, billingPeriodEnd: 'soon' } });
  assert.equal(unknown.windows[0].id, 'current');

  // A span that is neither a week nor a month is not labelled 7d
  const daily = billingToCapacity({
    config: {
      creditUsagePercent: 5,
      billingPeriodStart: '2026-10-02T00:00:00Z',
      billingPeriodEnd: '2026-10-03T00:00:00Z',
    },
  });
  assert.equal(daily.windows[0].id, 'current');
});
