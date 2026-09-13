/**
 * Discover OpenCode models via `opencode models`.
 * Output lines look like: `opencode/big-pickle`, `anthropic/claude-fable-5`
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  commonCliBinDirs,
  decodeCliOutput,
  enrichPathWithBinDirs,
  resolveCliSpawn,
  resolveOpenCodeCliPath,
} from '../../utils/cli-path.js';

function stripAnsi(input) {
  return String(input || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function formatLabel(fullId) {
  const trimmed = String(fullId || '').trim();
  if (!trimmed) return 'OpenCode';
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return trimmed;
  const provider = trimmed.slice(0, slash);
  const model = trimmed.slice(slash + 1);
  // Title-case-ish for display; keep provider prefix like the desktop client.
  const prettyModel = model
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('-');
  return `${provider}/${prettyModel}`;
}

/**
 * A model id looks like `provider/model`. Reject Windows paths (`C:/...`),
 * URLs, and UNC-ish tokens so noisy CLI output cannot become a bogus model.
 * @param {string} part
 * @returns {boolean}
 */
function isModelIdToken(part) {
  if (!part || !part.includes('/')) return false;
  if (/^[a-z]:[\/\\]/i.test(part)) return false;
  if (/^https?:\/\//i.test(part)) return false;
  if (part.includes('\\')) return false;
  return /^[\w.-]+\/[\w./-]+$/.test(part);
}

/**
 * Parse `opencode models` stdout into model entries.
 * @param {string} stdout
 * @returns {{ id: string, label: string, description?: string }[]}
 */
export function parseOpenCodeModelsOutput(stdout) {
  const clean = stripAnsi(stdout);
  const seen = new Set();
  const models = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const token = line.split(/\s+/).find(isModelIdToken);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    models.push({
      id: token,
      label: formatLabel(token),
      description: token,
    });
  }
  return models;
}

/**
 * Windows fallback: some opencode builds lose piped stdout entirely when
 * spawned non-TTY (Bun-compiled binary on Windows). Redirecting through
 * cmd's file handle (`opencode models > file`) bypasses the pipe path.
 *
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} raw file content, '' on any failure
 */
export function runModelsViaTempRedirect(bin, env) {
  // mkdtemp gives an unpredictable, exclusively-owned directory (CWE-377): a
  // predictable tmpdir path would let another local process pre-create or
  // symlink the redirect target.
  const tmpDir = mkdtempSync(join(tmpdir(), 'cc-gui-opencode-models-'));
  const tmpFile = join(tmpDir, 'models.txt');
  try {
    const invocation = resolveCliSpawn(bin, ['models'], {
      env,
      timeout: 45_000,
      stdio: ['ignore', 'ignore', 'ignore'],
      redirectTo: tmpFile,
    });
    spawnSync(invocation.file, invocation.args, invocation.options);
    return readFileSync(tmpFile, 'utf8');
  } catch {
    return '';
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * List models available to the local OpenCode CLI.
 * Prints a single JSON object to stdout (for channel-manager listModels).
 */
export function listModels() {
  const bin = resolveOpenCodeCliPath();
  const env = { ...process.env };
  enrichPathWithBinDirs(env, commonCliBinDirs(homedir()));

  let result;
  try {
    const invocation = resolveCliSpawn(bin, ['models'], {
      env,
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer',
    });
    result = spawnSync(invocation.file, invocation.args, invocation.options);
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error?.message || String(error),
      models: [],
    }));
    return;
  }

  const stdout = decodeCliOutput(result.stdout);
  const stderr = decodeCliOutput(result.stderr);

  if (result.error) {
    const hint = result.error.code === 'ENOENT'
      ? 'OpenCode CLI not found. Install it and ensure `opencode` is on PATH (or set OPENCODE_BIN).'
      : (result.error.message || String(result.error));
    console.log(JSON.stringify({ success: false, error: hint, models: [] }));
    return;
  }

  let models = parseOpenCodeModelsOutput(stdout);
  let source = models.length > 0 ? 'stdout' : null;

  // Some builds emit the list on stderr instead of stdout.
  if (models.length === 0 && stderr) {
    models = parseOpenCodeModelsOutput(stderr);
    if (models.length > 0) source = 'stderr';
  }

  // Windows: piped stdout can come back empty (or the first spawn can fail
  // with a quoting error) even when the CLI works in a terminal — retry once
  // through cmd file redirection before surfacing the failure.
  if (models.length === 0 && process.platform === 'win32') {
    const fromFile = parseOpenCodeModelsOutput(runModelsViaTempRedirect(bin, env));
    if (fromFile.length > 0) {
      models = fromFile;
      source = result.status === 0 ? 'file-redirect' : 'file-redirect-after-error';
    }
  }

  if (result.status !== 0 && models.length === 0) {
    const errTail = stderr.trim().slice(-800);
    console.log(JSON.stringify({
      success: false,
      error: `opencode models failed (code ${result.status})${errTail ? `: ${errTail}` : ''}`,
      models: [],
    }));
    return;
  }

  if (models.length === 0) {
    // Keep a default entry so UI always has a selectable fallback. Attach the
    // raw output tails so support can tell "no providers configured" apart
    // from "output lost on Windows pipes" from the IDE log.
    models.push({
      id: 'opencode-default',
      label: 'OpenCode Default',
      description: 'Use OpenCode CLI default model',
    });
  }

  const payload = { success: true, provider: 'opencode', models };
  const usedDefaultFallback = models.length === 1 && models[0].id === 'opencode-default';
  if (usedDefaultFallback) {
    // Surfaces in the IDE log via CliModelsHandler — key for telling
    // "no providers configured" apart from "output lost on Windows pipes".
    payload.debug = {
      reason: 'no-models-parsed',
      status: result.status,
      stdoutTail: stdout.slice(-500),
      stderrTail: stderr.slice(-500),
    };
  } else if (source && source !== 'stdout') {
    payload.debug = { modelsSource: source };
  }
  console.log(JSON.stringify(payload));
}
