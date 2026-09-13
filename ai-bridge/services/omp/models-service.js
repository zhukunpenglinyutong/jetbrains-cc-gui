/**
 * Discover OMP models via `omp models --json`.
 * Output is a JSON object:
 *   { "models": [ { "provider", "id", "selector", "name", "contextWindow",
 *                   "maxTokens", "reasoning", "thinking": [], "input": [],
 *                   "cost": {} } ] }
 */

import { spawnSync } from 'child_process';
import { homedir } from 'os';
import {
  commonCliBinDirs,
  enrichPathWithBinDirs,
  isWindowsCmdShim,
  resolveOmpCliPath,
} from '../../utils/cli-path.js';

function stripAnsi(input) {
  return String(input || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function formatCtx(contextWindow) {
  const value = Number(contextWindow);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(value);
}

/**
 * Parse `omp models --json` stdout into model entries.
 * Tolerates missing fields: entries without a string `selector` are skipped,
 * missing context/reasoning/input fields just omit that description segment.
 * @param {string} stdout
 * @returns {{ id: string, label: string, description?: string }[]}
 */
export function parseOmpModelsJson(stdout) {
  const parsed = JSON.parse(stripAnsi(stdout));
  const list = parsed && Array.isArray(parsed.models) ? parsed.models : [];
  const seen = new Set();
  const models = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const selector = entry.selector;
    if (typeof selector !== 'string' || !selector.trim()) continue;
    const id = selector.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const details = [];
    const ctx = formatCtx(entry.contextWindow);
    if (ctx) details.push(`ctx ${ctx}`);
    if (entry.reasoning === true) details.push('thinking');
    if (Array.isArray(entry.input) && entry.input.includes('image')) details.push('vision');
    models.push({
      id,
      label: id,
      description: details.length > 0 ? details.join(' · ') : id,
    });
  }
  return models;
}

/**
 * Parse `omp config get modelRoles --json` stdout into role entries.
 * Output shape: { "key": "modelRoles", "value": { "<role>": "<selector>" } }.
 * The `default` role is excluded (the UI Default mode maps to no --model flag).
 * @param {string} stdout
 * @returns {{ id: string, label: string, description?: string }[]}
 */
export function parseOmpRolesJson(stdout) {
  const parsed = JSON.parse(stripAnsi(stdout));
  const map = parsed && typeof parsed.value === 'object' && parsed.value !== null
    ? parsed.value
    : {};
  const roles = [];
  for (const [role, selector] of Object.entries(map)) {
    if (role === 'default') continue;
    if (typeof selector !== 'string' || !selector.trim()) continue;
    roles.push({ id: role, label: role, description: selector.trim() });
  }
  return roles;
}

/**
 * Best-effort model-role discovery. Any failure (old omp, no config, bad JSON)
 * yields an empty list — roles are additive UI data and must never fail listModels.
 */
function fetchOmpRoles(bin, env) {
  try {
    const result = spawnSync(bin, ['config', 'get', 'modelRoles', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      // Windows npm `.cmd` shims require a shell to spawn.
      shell: isWindowsCmdShim(bin),
    });
    if (!result || result.error || result.status !== 0) return [];
    return parseOmpRolesJson(result.stdout || '');
  } catch {
    return [];
  }
}
/**
 * List models available to the local OMP CLI.
 * Prints a single JSON object to stdout (for channel-manager listModels).
 */
export function listModels() {
  const bin = resolveOmpCliPath();
  const env = { ...process.env };
  enrichPathWithBinDirs(env, commonCliBinDirs(homedir()));

  let result;
  try {
    result = spawnSync(bin, ['models', '--json'], {
      encoding: 'utf8',
      env,
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
      // Windows npm `.cmd` shims require a shell to spawn.
      shell: isWindowsCmdShim(bin),
    });
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error?.message || String(error),
      models: [],
    }));
    return;
  }

  if (result.error) {
    const hint = result.error.code === 'ENOENT'
      ? 'OMP CLI not found. Install it and ensure `omp` is on PATH (or set OMP_BIN).'
      : (result.error.message || String(result.error));
    console.log(JSON.stringify({ success: false, error: hint, models: [] }));
    return;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().slice(-800);
    console.log(JSON.stringify({
      success: false,
      error: `omp models --json failed (code ${result.status})${stderr ? `: ${stderr}` : ''}`,
      models: [],
    }));
    return;
  }

  let models;
  try {
    models = parseOmpModelsJson(result.stdout || '');
  } catch (error) {
    const raw = String(result.stdout || '').trim().slice(-800);
    console.log(JSON.stringify({
      success: false,
      error: `omp models --json returned invalid JSON: ${error?.message || error}${raw ? ` (${raw})` : ''}`,
      models: [],
    }));
    return;
  }
  // Keep a default entry so UI always has a selectable fallback.
  if (models.length === 0) {
    models.push({
      id: 'auto',
      label: 'OMP Auto',
      description: 'Use OMP CLI default model',
    });
  }

  console.log(JSON.stringify({ success: true, provider: 'omp', models, roles: fetchOmpRoles(bin, env) }));
}
