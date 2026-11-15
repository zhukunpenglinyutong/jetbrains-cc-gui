import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCapacityPayload,
  collectPlanUsage,
  parseRoleMap,
  parseSelector,
  pickReport,
  resolveProvider,
  selectApplicableLimits,
} from './plan-usage-service.js';

const ROLES_JSON = JSON.stringify({
  key: 'modelRoles',
  value: {
    default: 'anthropic/claude-opus-5-5:xhigh',
    smol: 'github-copilot/gpt-5-mini',
  },
});

const USAGE = {
  generatedAt: 1794336979268,
  reports: [
    {
      provider: 'anthropic',
      limits: [
        {
          id: 'anthropic:5h',
          scope: { provider: 'anthropic', windowId: '5h', shared: true },
          window: { id: '5h', durationMs: 18000000, resetsAt: 1794354000000 },
          amount: { used: 10, limit: 100, usedFraction: 0.1, unit: 'percent' },
        },
        {
          id: 'anthropic:7d',
          scope: { provider: 'anthropic', windowId: '7d', shared: true },
          window: { id: '7d', durationMs: 604800000, resetsAt: 1794600000000 },
          amount: { used: 13, limit: 100, usedFraction: 0.13, unit: 'percent' },
        },
        {
          id: 'anthropic:7d:fable',
          scope: { provider: 'anthropic', windowId: '7d', tier: 'fable' },
          window: { id: '7d', durationMs: 604800000, resetsAt: 1794600000000 },
          amount: { used: 20, limit: 100, usedFraction: 0.2, unit: 'percent' },
        },
      ],
      metadata: { accountId: 'x' },
    },
    {
      provider: 'github-copilot',
      limits: [
        {
          id: 'copilot:premium',
          scope: { provider: 'github-copilot', tier: 'business', windowId: 'monthly' },
          window: { id: 'monthly', resetsAt: 1796083200000 },
          amount: { used: 5250, limit: 13000, usedFraction: 0.40384615384615385, unit: 'requests' },
        },
      ],
      metadata: { plan: 'business' },
    },
  ],
};

function fakeRun({ roles = ROLES_JSON, usage = USAGE } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'config') return { status: 0, stdout: roles };
    return { status: 0, stdout: JSON.stringify(usage) };
  };
  return { run, calls };
}

test('selector with level suffix resolves its provider', () => {
  assert.deepEqual(parseSelector('anthropic/claude-opus-5-5:xhigh'), {
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
  });
  assert.deepEqual(resolveProvider('openrouter/foo:free'), { provider: 'openrouter', modelId: 'foo:free' });
  assert.equal(resolveProvider('gpt-5'), null);
});

test('role id resolves through the role map', () => {
  const roles = parseRoleMap(ROLES_JSON);
  assert.deepEqual(resolveProvider('smol', roles), { provider: 'github-copilot', modelId: 'gpt-5-mini' });
  assert.equal(resolveProvider('unknown', roles), null);
});

test('auto and empty use the default role', () => {
  const roles = parseRoleMap(ROLES_JSON);
  const expected = { provider: 'anthropic', modelId: 'claude-opus-5-5' };
  assert.deepEqual(resolveProvider('auto', roles), expected);
  assert.deepEqual(resolveProvider('', roles), expected);
  assert.equal(resolveProvider('auto', {}), null);
});

test('tier limit wins for a matching model (case-insensitive)', () => {
  const report = pickReport(JSON.stringify(USAGE), 'anthropic');
  const limits = selectApplicableLimits(report.limits, 'Claude-Fable-5');
  const week = limits.find((l) => l.window.id === '7d');
  assert.equal(week.id, 'anthropic:7d:fable');
  assert.equal(limits.length, 2);
});

test('shared limit is used when no tier matches', () => {
  const report = pickReport(JSON.stringify(USAGE), 'anthropic');
  const limits = selectApplicableLimits(report.limits, 'claude-opus-5-5');
  assert.deepEqual(limits.map((l) => l.id), ['anthropic:5h', 'anthropic:7d']);
});

test('capacity payload maps 5h and 7d windows', () => {
  const report = pickReport(JSON.stringify(USAGE), 'anthropic');
  const payload = buildCapacityPayload(report, 'claude-opus-5-5');
  assert.equal(payload.present, true);
  assert.equal(payload.capacity_pct, 10);
  assert.equal(payload.period_type, '5h');
  assert.deepEqual(payload.windows, [
    { id: '5h', used_pct: 10, reset_at: new Date(1794354000000).toISOString(), period_type: '5h' },
    { id: '7d', used_pct: 13, reset_at: new Date(1794600000000).toISOString(), period_type: '7d' },
  ]);
});

test('plan-tier limit without durationMs is account-wide and treated as monthly', () => {
  const report = pickReport(JSON.stringify(USAGE), 'github-copilot');
  assert.equal(report.limits[0].scope.tier, 'business');
  const payload = buildCapacityPayload(report, 'gpt-5-mini');
  assert.equal(payload.present, true);
  assert.equal(payload.level, 'business');
  assert.equal(payload.windows.length, 1);
  assert.equal(payload.windows[0].id, 'monthly');
  assert.equal(payload.windows[0].period_type, 'monthly');
  assert.equal(payload.windows[0].used_pct, 40.38);
  assert.equal(payload.capacity_pct, 40.38);
});

test('plan match is case-insensitive and trimmed', () => {
  const report = pickReport(JSON.stringify(USAGE), 'github-copilot');
  const limits = selectApplicableLimits(report.limits, 'gpt-5-mini', { plan: '  Business ' });
  assert.equal(limits.length, 1);
});

test('tiered limit matching neither the model nor the plan is excluded', () => {
  const report = pickReport(JSON.stringify(USAGE), 'github-copilot');
  const other = { ...report.limits[0], scope: { ...report.limits[0].scope, tier: 'enterprise' } };
  assert.deepEqual(selectApplicableLimits([other], 'gpt-5-mini', report.metadata), []);
  const payload = buildCapacityPayload({ ...report, limits: [other] }, 'gpt-5-mini');
  assert.equal(payload.present, false);
  assert.equal(payload.unavailable, true);
});

test('provider absent from reports is unavailable', () => {
  const { run } = fakeRun();
  const payload = collectPlanUsage('kimi-code/k2', run);
  assert.equal(payload.present, false);
  assert.equal(payload.unavailable, true);
  assert.equal(payload.provider, 'omp');
});

test('collectPlanUsage queries only the resolved provider', () => {
  const { run, calls } = fakeRun();
  const payload = collectPlanUsage('auto', run);
  assert.equal(payload.present, true);
  assert.deepEqual(calls, [
    ['config', 'get', 'modelRoles', '--json'],
    ['usage', '--json', '--provider', 'anthropic'],
  ]);
});

test('explicit selector skips the role lookup', () => {
  const { run, calls } = fakeRun();
  collectPlanUsage('anthropic/claude-opus-5-5:high', run);
  assert.deepEqual(calls.map((c) => c[0]), ['usage']);
});

test('failures yield the unavailable payload', () => {
  const notFound = () => ({ error: Object.assign(new Error('spawn omp ENOENT'), { code: 'ENOENT' }) });
  assert.equal(collectPlanUsage('anthropic/x', notFound).present, false);
  assert.equal(collectPlanUsage('anthropic/x', () => ({ status: 1, stdout: '', stderr: 'boom' })).present, false);
  assert.equal(collectPlanUsage('anthropic/x', () => ({ status: 0, stdout: 'not json' })).present, false);
  assert.equal(collectPlanUsage('anthropic/x', () => { throw new Error('spawn failed'); }).present, false);
  assert.equal(collectPlanUsage('auto', () => ({ status: 0, stdout: '{}' })).present, false);
});

test('provider ids that are not plain ids are rejected', () => {
  const { run, calls } = fakeRun();
  const payload = collectPlanUsage('a b&c/model', run);
  assert.equal(payload.present, false);
  assert.equal(calls.length, 0);
});
