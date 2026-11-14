/**
 * Discover Gemini models from the Antigravity CLI (`agy models`).
 *
 * The listing is a local catalog probe — zero tokens, no auth round-trip.
 * stdout is one `id<TAB>Human Label` pair per line; the CLI's
 * "Fetching available models..." spinner goes to stderr, but the parser
 * stays defensive anyway (unknown/blank/tab-less lines are skipped, never
 * thrown on — the CLI may add columns or entries at any time).
 *
 * The sentinel `auto` (= omit `--model`, let the CLI pick its own default)
 * is offered first as a real, honest choice. No default slug is invented:
 * the CLI's default is not advertised by `agy models`, and `auto` can never
 * send a wrong-vendor slug. Tier selection is baked into the full slug
 * (`gemini-3.7-flash-high`); there is no separate `--effort` for gemini.
 *
 * Failure is honest: CLI absent / timeout / nonzero exit answers
 * `{success:false, ..., models:[]}` — never a fabricated catalog.
 */

import { spawnSync } from 'node:child_process';
import {
  commonCliBinDirs,
  decodeCliOutput,
  enrichPathWithBinDirs,
  resolveCliSpawn,
  resolveGeminiCliPath,
} from '../../utils/cli-path.js';
import { normalizeGeminiModelId } from './message-service.js';

export const GEMINI_DEFAULT_MODEL_ID = 'auto';

const GEMINI_AUTO_MODEL = {
  id: GEMINI_DEFAULT_MODEL_ID,
  label: 'Default (CLI)',
  description: 'Use the Antigravity CLI default model',
};

// Below the Java CliModelsHandler's 50s so the channel always answers.
const DEFAULT_MODELS_TIMEOUT_MS = 40_000;

/**
 * Parse `agy models` stdout into `{id, label}` entries.
 * Extra tab-separated columns collapse into the label; blank, tab-less, and
 * duplicate-id lines are skipped silently.
 */
export function parseAgyModelsOutput(text) {
  if (typeof text !== 'string') return [];
  const models = [];
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const tabIndex = line.indexOf('\t');
    if (tabIndex <= 0) continue;
    const id = line.slice(0, tabIndex).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = line
      .slice(tabIndex + 1)
      .split('\t')
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ');
    models.push({ id, label: label || id });
  }
  return models;
}

function failurePayload(error) {
  const payload = {
    success: false,
    provider: 'gemini',
    defaultModel: GEMINI_DEFAULT_MODEL_ID,
    error,
    models: [],
  };
  console.log(JSON.stringify(payload));
  return payload;
}

/**
 * Run `agy models` and answer the channel payload. Prints the payload JSON
 * on stdout (the Java channel protocol reads exactly one JSON line).
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 */
export function listModels(options = {}) {
  const opts = options || {};
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_MODELS_TIMEOUT_MS;

  const bin = resolveGeminiCliPath();
  // The IDE process PATH is often sparse; enrich it the same way the send
  // path does so a user-local agy is found without a login shell.
  const env = { ...process.env };
  enrichPathWithBinDirs(env, commonCliBinDirs());

  let proc;
  try {
    const spawnInfo = resolveCliSpawn(bin, ['models'], {
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    proc = spawnSync(spawnInfo.file, spawnInfo.args, spawnInfo.options);
  } catch (err) {
    return failurePayload(`Failed to spawn Antigravity CLI (${bin}): ${err?.message || err}`);
  }

  if (proc?.error) {
    if (proc.error.code === 'ENOENT') {
      return failurePayload(
        `Antigravity CLI (agy) not found at ${bin}. Install it or set GEMINI_BIN (or GEMINI_PATH / GEMINI_CLI_PATH).`,
      );
    }
    if (proc.error.code === 'ETIMEDOUT' || proc.error.signal === 'SIGTERM') {
      return failurePayload(
        `Antigravity CLI (agy models) timed out after ${timeoutMs}ms while fetching the model catalog.`,
      );
    }
    return failurePayload(`Failed to run Antigravity CLI (agy models) (${bin}): ${proc.error.message}`);
  }

  if (proc.signal) {
    return failurePayload(`Antigravity CLI (agy models) was terminated by signal ${proc.signal}.`);
  }
  if (proc.status !== 0) {
    const stderrTail = decodeCliOutput(proc.stderr).trim().slice(0, 200);
    return failurePayload(
      `Antigravity CLI (agy models) exited with code ${proc.status}${stderrTail ? `: ${stderrTail}` : ''}.`,
    );
  }

  // A catalog line whose id equals the 'auto' sentinel would render a second
  // "Default (CLI)" row, and ids the send path silently collapses (sentinels,
  // dash-led tokens) must not be offered either — the payload is where
  // picker-offered ids are pinned to sendable ones. parseAgyModelsOutput
  // stays permissive by design (unknown catalog lines are skipped, not fatal).
  const catalog = parseAgyModelsOutput(decodeCliOutput(proc.stdout))
    .filter((m) => normalizeGeminiModelId(m.id) === m.id);
  const payload = {
    success: true,
    provider: 'gemini',
    defaultModel: GEMINI_DEFAULT_MODEL_ID,
    models: [GEMINI_AUTO_MODEL, ...catalog],
  };
  console.log(JSON.stringify(payload));
  return payload;
}
