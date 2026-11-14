/**
 * OMP plan usage via `omp usage --json --provider <id>`.
 *
 * Prints one JSON line in the plugin's capacity payload shape
 * (`webview/src/utils/planUsagePace.ts#parseCapacityPayload`, built in Java by
 * `RelayUsageJson.capacityPayload`). Every failure prints the "unavailable" payload
 * (`present:false`), which hides the bar; nothing here throws.
 */

import { homedir } from 'os';
import {
  commonCliBinDirs,
  enrichPathWithBinDirs,
  resolveOmpCliPath,
} from '../../utils/cli-path.js';
import { spawnCliSync } from '../../utils/cli-spawn.js';

const USAGE_TIMEOUT_MS = 30_000;
const ROLES_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const SOURCE = 'omp usage';
/** Thinking levels omp accepts after the last `:` of a model selector. */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Provider ids reach a (possibly shell-spawned) command line; allow plain ids only. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function stripAnsi(input) {
  return String(input || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Same shape as `GrokSDKBridge.planUsageUnavailable`. */
export function planUsageUnavailable(message) {
  return {
    present: false,
    unavailable: true,
    provider: 'omp',
    source: SOURCE,
    message: message || 'OMP usage unavailable',
  };
}

/**
 * Parse `omp config get modelRoles --json` stdout into a `{ role: selector }` map
 * (the `default` role included).
 * @param {string} stdout
 * @returns {Record<string, string>}
 */
export function parseRoleMap(stdout) {
  const parsed = JSON.parse(stripAnsi(stdout));
  const value = parsed && typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : {};
  const roles = {};
  for (const [role, selector] of Object.entries(value)) {
    if (typeof selector === 'string' && selector.trim()) roles[role] = selector.trim();
  }
  return roles;
}

/**
 * Split `<provider>/<model id>[:level]` into its provider and model id.
 * @param {string} selector
 * @returns {{ provider: string, modelId: string } | null}
 */
export function parseSelector(selector) {
  let text = String(selector || '').trim();
  const colon = text.lastIndexOf(':');
  if (colon > 0 && THINKING_LEVELS.has(text.slice(colon + 1).toLowerCase())) {
    text = text.slice(0, colon);
  }
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

/**
 * Whether the plugin's model value needs the role map to resolve: `auto`, empty, or a
 * bare role id (anything that is not a `<provider>/<id>` selector).
 * @param {string} model
 */
export function needsRoles(model) {
  const text = String(model || '').trim();
  return !text.includes('/');
}

/**
 * Resolve the plugin's model value to `{ provider, modelId }`.
 * @param {string} model selector, `auto`/empty (default role) or a role id
 * @param {Record<string, string>} [roles] role map from `parseRoleMap`
 * @returns {{ provider: string, modelId: string } | null}
 */
export function resolveProvider(model, roles = {}) {
  const text = String(model || '').trim();
  if (text.includes('/')) return parseSelector(text);
  const role = !text || text.toLowerCase() === 'auto' ? 'default' : text;
  const selector = roles[role];
  return selector ? parseSelector(selector) : null;
}

/**
 * Limits that apply to the model: untiered ones, plus tiered ones whose tier occurs in
 * the model id (a model-family meter) or equals `metadata.plan` (the tier is the account's
 * plan, so the limit is account-wide). Limits sharing a `window.id` collapse to the most
 * used one.
 * @param {object[]} limits `report.limits`
 * @param {string} modelId
 * @param {{ plan?: string }} [metadata] `report.metadata`
 * @returns {object[]} in first-seen window order
 */
export function selectApplicableLimits(limits, modelId, metadata) {
  if (!Array.isArray(limits)) return [];
  const id = String(modelId || '').toLowerCase();
  const plan = typeof metadata?.plan === 'string' ? metadata.plan.trim().toLowerCase() : '';
  const byWindow = new Map();
  for (const limit of limits) {
    const windowId = limit?.window?.id;
    if (typeof windowId !== 'string' || !windowId) continue;
    const tier = limit.scope?.tier;
    if (tier !== undefined && tier !== null && tier !== '') {
      if (typeof tier !== 'string') continue;
      const wanted = tier.trim().toLowerCase();
      if (!id.includes(wanted) && wanted !== plan) continue;
    }
    if (usedPercent(limit) === null) continue;
    const kept = byWindow.get(windowId);
    if (!kept || usedPercent(limit) > usedPercent(kept)) byWindow.set(windowId, limit);
  }
  return [...byWindow.values()];
}

/** Used share of the limit in percent, or `null` when omp reported nothing usable. */
function usedPercent(limit) {
  const amount = limit?.amount;
  if (!amount) return null;
  let fraction = amount.usedFraction;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) {
    const { used, limit: cap } = amount;
    if (typeof used !== 'number' || typeof cap !== 'number' || !(cap > 0)) return null;
    fraction = used / cap;
  }
  return Math.min(100, Math.max(0, fraction * 100));
}

/** `period_type` for the webview's pace math: `5h` / `7d` / `monthly`, else the window id. */
function periodType(window) {
  const duration = window.durationMs;
  if (typeof duration === 'number') {
    if (duration === FIVE_HOURS_MS) return '5h';
    if (duration === SEVEN_DAYS_MS) return '7d';
    if (duration >= 28 * DAY_MS && duration <= 31 * DAY_MS) return 'monthly';
  }
  return window.id;
}

function windowRank(limit) {
  const duration = limit.window.durationMs;
  return typeof duration === 'number' ? duration : Number.POSITIVE_INFINITY;
}

function toWindow(limit) {
  const out = {
    id: limit.window.id,
    used_pct: Math.round(usedPercent(limit) * 100) / 100,
  };
  const resetsAt = limit.window.resetsAt;
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt >= 0) {
    out.reset_at = new Date(resetsAt).toISOString();
  }
  out.period_type = periodType(limit.window);
  return out;
}

/**
 * Build the capacity payload from one `omp usage` report. The binding `capacity_pct`
 * prefers the 5h window and otherwise the worst one, as `RelayUsageJson.capacityPayload`.
 * @param {object} report entry of `reports[]`
 * @param {string} modelId model id without provider prefix
 * @returns {object} capacity payload, or the unavailable payload when no limit applies
 */
export function buildCapacityPayload(report, modelId) {
  const limits = selectApplicableLimits(report?.limits, modelId, report?.metadata)
    .sort((a, b) => windowRank(a) - windowRank(b));
  if (limits.length === 0) return planUsageUnavailable('No applicable OMP usage limit');
  const windows = limits.map(toWindow);
  const five = windows.find((w) => w.id === '5h');
  const capacity = five ? five.used_pct : Math.max(...windows.map((w) => w.used_pct));
  const payload = {
    ok: true,
    present: true,
    provider: 'omp',
    source: SOURCE,
    capacity_pct: capacity,
    period_type: windows[0].period_type,
    windows,
  };
  const plan = report?.metadata?.plan;
  if (typeof plan === 'string' && plan) payload.level = plan;
  return payload;
}

/**
 * Pick the report of `provider` out of `omp usage --json` stdout.
 * @returns {object | null}
 */
export function pickReport(stdout, provider) {
  const parsed = JSON.parse(stripAnsi(stdout));
  const reports = Array.isArray(parsed?.reports) ? parsed.reports : [];
  const wanted = String(provider).toLowerCase();
  return reports.find((r) => typeof r?.provider === 'string' && r.provider.toLowerCase() === wanted) || null;
}

function runOmp(bin, env, args, timeout) {
  return spawnCliSync(bin, args, {
    encoding: 'utf8',
    env,
    timeout,
    maxBuffer: MAX_BUFFER_BYTES,
  });
}

function failureMessage(result, what) {
  if (result.error) {
    return result.error.code === 'ENOENT'
      ? 'OMP CLI not found. Install it and ensure `omp` is on PATH (or set OMP_BIN).'
      : (result.error.message || String(result.error));
  }
  const stderr = String(result.stderr || '').trim().slice(-400);
  return `${what} failed (code ${result.status})${stderr ? `: ${stderr}` : ''}`;
}

/**
 * Resolve the payload for `model`. `run(args, timeoutMs)` returns a spawnSync-like result;
 * injected by tests.
 * @returns {object}
 */
export function collectPlanUsage(model, run) {
  let roles = {};
  if (needsRoles(model)) {
    let result;
    try {
      result = run(['config', 'get', 'modelRoles', '--json'], ROLES_TIMEOUT_MS);
    } catch (error) {
      return planUsageUnavailable(error?.message || String(error));
    }
    if (result.error || result.status !== 0) {
      return planUsageUnavailable(failureMessage(result, 'omp config get modelRoles'));
    }
    try {
      roles = parseRoleMap(result.stdout || '');
    } catch {
      return planUsageUnavailable('omp config get modelRoles returned invalid JSON');
    }
  }

  const resolved = resolveProvider(model, roles);
  if (!resolved || !PROVIDER_ID_PATTERN.test(resolved.provider)) {
    return planUsageUnavailable('Cannot resolve the OMP provider of the current model');
  }

  let result;
  try {
    result = run(['usage', '--json', '--provider', resolved.provider], USAGE_TIMEOUT_MS);
  } catch (error) {
    return planUsageUnavailable(error?.message || String(error));
  }
  if (result.error || result.status !== 0) {
    return planUsageUnavailable(failureMessage(result, 'omp usage --json'));
  }
  let report;
  try {
    report = pickReport(result.stdout || '', resolved.provider);
  } catch {
    return planUsageUnavailable('omp usage --json returned invalid JSON');
  }
  if (!report) return planUsageUnavailable(`OMP reports no usage for ${resolved.provider}`);
  return buildCapacityPayload(report, resolved.modelId);
}

/**
 * Print the plan-usage payload for the plugin's current OMP model as one JSON line.
 * @param {{ model?: string }} input
 */
export async function getPlanUsage({ model } = {}) {
  let payload;
  try {
    const bin = resolveOmpCliPath();
    const env = { ...process.env };
    enrichPathWithBinDirs(env, commonCliBinDirs(homedir()));
    payload = collectPlanUsage(model, (args, timeout) => runOmp(bin, env, args, timeout));
  } catch (error) {
    payload = planUsageUnavailable(error?.message || String(error));
  }
  console.log(JSON.stringify(payload));
}
