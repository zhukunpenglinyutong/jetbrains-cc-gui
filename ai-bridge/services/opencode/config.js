/**
 * Read OpenCode's own config files (opencode.json / opencode.jsonc).
 *
 * The Java side (OpenCodeContextWindowResolver) mirrors this lookup for
 * history restore; keep the candidate order and JSONC handling in step.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DEFAULT_MODELS = new Set([
  '__config_default__',
  'auto',
  'default',
  '(default)',
  'config-default',
  'config_default',
  'opencode default',
  'opencode-default',
]);

/**
 * Map the UI model id to an explicit `--model` value, or null when the user
 * picked "use OpenCode's configured default".
 */
export function resolveModelFlag(model) {
  if (model == null) return null;
  const trimmed = String(model).trim();
  if (!trimmed) return null;
  return CONFIG_DEFAULT_MODELS.has(trimmed.toLowerCase()) ? null : trimmed;
}

/** Copy a string literal starting at `start` (the opening quote); return the index after it. */
function copyStringLiteral(src, start, out) {
  out.push('"');
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i++];
    out.push(ch);
    if (ch === '\\' && i < src.length) {
      out.push(src[i++]);
    } else if (ch === '"') {
      break;
    }
  }
  return i;
}

function stripComments(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      i = copyStringLiteral(raw, i, out);
    } else if (ch === '/' && raw[i + 1] === '/') {
      const end = raw.indexOf('\n', i);
      i = end < 0 ? raw.length : end;
    } else if (ch === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2);
      i = end < 0 ? raw.length : end + 2;
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join('');
}

function closesAfterWhitespace(text, from) {
  let j = from;
  while (j < text.length && /\s/.test(text[j])) j++;
  return text[j] === '}' || text[j] === ']';
}

function stripTrailingCommas(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = copyStringLiteral(text, i, out);
      continue;
    }
    if (ch !== ',' || !closesAfterWhitespace(text, i + 1)) {
      out.push(ch);
    }
    i++;
  }
  return out.join('');
}

/**
 * Parse JSONC: comments and trailing commas outside string literals are dropped.
 *
 * @param {string} raw file contents
 * @returns {*} parsed value
 * @throws {SyntaxError} when the remaining text is not valid JSON
 */
export function parseJsonc(raw) {
  return JSON.parse(stripTrailingCommas(stripComments(String(raw ?? ''))));
}

function readContextLimit(models, keys) {
  if (!models || typeof models !== 'object') return null;
  for (const key of keys) {
    const limit = Math.floor(Number(models[key]?.limit?.context) || 0);
    if (limit > 0) return limit;
  }
  return null;
}

function lookupContextLimitInConfig(config, effectiveModel) {
  if (!config || typeof config !== 'object' || !effectiveModel) return null;
  const providers = config.provider && typeof config.provider === 'object'
    ? config.provider
    : (config.providers && typeof config.providers === 'object' ? config.providers : null);
  if (!providers) return null;

  const slashIdx = effectiveModel.indexOf('/');
  const providerId = slashIdx > 0 ? effectiveModel.slice(0, slashIdx) : null;
  const modelId = slashIdx > 0 ? effectiveModel.slice(slashIdx + 1) : effectiveModel;

  const direct = providerId ? readContextLimit(providers[providerId]?.models, [modelId, effectiveModel]) : null;
  if (direct) return direct;
  for (const prov of Object.values(providers)) {
    const candidate = readContextLimit(prov?.models, [effectiveModel, modelId]);
    if (candidate) return candidate;
  }
  return null;
}

function candidateConfigPaths(cwd, home) {
  const candidates = [];
  if (cwd && cwd !== 'undefined' && cwd !== 'null') {
    candidates.push(
      join(cwd, 'opencode.json'),
      join(cwd, 'opencode.jsonc'),
      join(cwd, '.opencode', 'opencode.json'),
      join(cwd, '.opencode', 'opencode.jsonc')
    );
  }
  if (process.env.OPENCODE_CONFIG) {
    candidates.push(process.env.OPENCODE_CONFIG);
  }
  if (process.env.OPENCODE_CONFIG_DIR) {
    candidates.push(
      join(process.env.OPENCODE_CONFIG_DIR, 'opencode.json'),
      join(process.env.OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
      join(process.env.OPENCODE_CONFIG_DIR, 'config.json')
    );
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || (home ? join(home, '.config') : '');
  if (xdgConfig) {
    candidates.push(
      join(xdgConfig, 'opencode', 'opencode.json'),
      join(xdgConfig, 'opencode', 'opencode.jsonc'),
      join(xdgConfig, 'opencode', 'config.json')
    );
  }
  return candidates;
}

function readConfigs(candidates) {
  const configs = [];
  for (const filePath of candidates) {
    try {
      if (!filePath || !existsSync(filePath)) continue;
      const parsed = parseJsonc(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        configs.push(parsed);
      }
    } catch {
      // Ignore unreadable or malformed config files.
    }
  }
  return configs;
}

/**
 * Resolve the configured context window (`limit.context`) for an OpenCode model
 * from `<cwd>/opencode.json(c)` or `~/.config/opencode/opencode.json(c)`.
 * Project files come first, matching OpenCode's project-over-global precedence.
 *
 * @returns {number|null} context window in tokens, or null when none is declared
 */
export function resolveOpenCodeContextWindow(model, cwd = '', home = '') {
  const effectiveHome = home || process.env.HOME || process.env.USERPROFILE || homedir();
  const configs = readConfigs(candidateConfigPaths(cwd, effectiveHome));
  if (configs.length === 0) return null;

  const effectiveModel = resolveModelFlag(model)
    || configs.map((cfg) => (typeof cfg.model === 'string' ? cfg.model.trim() : '')).find(Boolean);
  if (!effectiveModel) return null;

  for (const cfg of configs) {
    const limit = lookupContextLimitInConfig(cfg, effectiveModel);
    if (limit) return limit;
  }
  return null;
}
