/**
 * .env file loader utility.
 * Parses KEY=VALUE format, skipping comments (#) and blank lines.
 * Supports quoted values ("..." or '...').
 *
 * Security: resolves env file paths against the project cwd to prevent path
 * traversal attacks (e.g. envFile="../../etc/passwd"), and FAILS CLOSED when no
 * project directory is available rather than reading an unanchored absolute
 * path. Only files whose name is on an exact-match allowlist inside the project
 * are read, and the file that is read is the exact realpath the containment
 * check cleared. Environment variable names that could hijack process startup
 * or the binary search path (NODE_OPTIONS, LD_PRELOAD, PATH, …) are dropped
 * before anything reaches process.env.
 *
 * Logging: diagnostics are gated behind CLAUDE_DEBUG and never contain env var
 * VALUES or absolute env-file paths — the daemon's stderr is mirrored into a
 * persistent idea.log by the Java bridge.
 */

import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, normalize, isAbsolute, sep } from 'node:path';
import { format } from 'node:util';
import { isEnvFileDeniedEnvVar } from '../config/api-config.js';

// Conditional debug logging: set CLAUDE_DEBUG=1 to enable verbose diagnostics
const DEBUG = process.env.CLAUDE_DEBUG === '1' || process.env.CLAUDE_DEBUG === 'true';
function debugLog(...args) {
  if (DEBUG) {
    // format() rather than console.error(): the latter does not interpolate
    // %d/%s placeholders, so specifiers would reach the log verbatim.
    console.error('[DEBUG]', format(...args));
  }
}

/**
 * Qualifiers that may follow a bare `.env`, e.g. `.env.local`.
 * The name has to be one WE chose — a file author picking their own suffix
 * behind a legitimate `.env` prefix is exactly what the allowlist exists to
 * prevent.
 */
const ALLOWED_ENV_QUALIFIERS = Object.freeze(['local', 'development', 'production', 'test', 'staging']);

/**
 * Allowed file names for env files. Prevents loading arbitrary files that might
 * contain secrets or be used for exploitation.
 */
const ALLOWED_ENV_EXTENSIONS = Object.freeze(new Set([
  '.env',
  ...ALLOWED_ENV_QUALIFIERS.map((qualifier) => `.env.${qualifier}`),
]));

/**
 * Whether a file basename is on the env-file allowlist.
 *
 * SECURITY BOUNDARY, not a hint. The previous predicate was
 * `baseName.startsWith(ext)` — a bare *prefix* match, so every one of
 * `.env.local.js`, `.env.production.bak`, `.env.test.sh` and `.env.stagingX`
 * was accepted and its contents parsed into process.env. The structural rule is
 * now "whole name, or the name plus exactly one dot-separated qualifier":
 *
 *     baseName === ext || baseName.startsWith(ext + '.')
 *
 * That alone is still not enough, and this is worth stating plainly: because
 * the allowlist itself contains dotted entries (`.env.local`, `.env.test`, …),
 * `.env.local.js` satisfies the `.env.local` + `.` rule and would still be
 * accepted. A structural rule about dots does not decide *which* qualifier is
 * allowed — only the full-name membership check below does.
 *
 * @param {string} baseName - Lower-cased basename of the candidate file
 * @returns {boolean} true when the file is an allowed env file
 */
function isAllowedEnvFileName(baseName) {
  for (const ext of ALLOWED_ENV_EXTENSIONS) {
    // Never a bare prefix — see above.
    if (baseName === ext || baseName.startsWith(ext + '.')) {
      // ...and the name must be a member of the allowlist in full, so that an
      // author-chosen extra suffix (".env.local.js") or an invented qualifier
      // (".env.stagingX") cannot ride in behind an entry we did list.
      return ALLOWED_ENV_EXTENSIONS.has(baseName);
    }
  }
  return false;
}

// Short, path-free reasons. `error` (see validateEnvFilePath) embeds resolved
// absolute paths and therefore stays behind CLAUDE_DEBUG; the always-on warning must be
// able to say *why* without printing an absolute path (which carries the user's
// home directory into a persistent idea.log).
const ERROR_CODE_MESSAGES = {
  NO_BASE_DIR: 'no project directory available to validate against',
  BAD_PATH_TYPE: 'file path is null/empty or not a string',
  NULL_BYTE: 'file path contains a null byte',
  OUTSIDE_BASE: 'path resolves outside project directory',
  RESOLUTION_FAILED: 'path resolution failed',
  BAD_EXTENSION: 'file does not match allowed env file patterns',
  NOT_FOUND: 'env file does not exist',
  NOT_A_FILE: 'env path is not a regular file',
  SYMLINK_ESCAPE: 'env file resolves outside project directory',
  REALPATH_FAILED: 'env file realpath resolution failed',
};

/**
 * Build a validation result.
 *
 * @param {string} code - Key into ERROR_CODE_MESSAGES
 * @param {string} [detail] - Verbose, path-bearing detail (CLAUDE_DEBUG only)
 * @returns {{path: null, realPath: null, error: string, reason: string, code: string}}
 *   `reason` is always path-free and safe for the unconditional warning;
 *   `error` is reason + detail and must stay behind CLAUDE_DEBUG.
 */
function validationError(code, detail) {
  const reason = ERROR_CODE_MESSAGES[code] || code;
  return {
    path: null,
    realPath: null,
    error: detail ? `${reason} (${detail})` : reason,
    reason,
    code,
  };
}

/**
 * Validate and resolve an env file path against a base directory (project cwd).
 *
 * Security checks performed:
 * 1. Fails closed when no base directory is supplied (see below)
 * 2. Rejects null/empty/non-string paths
 * 3. Rejects absolute paths that escape via .. traversal
 * 4. Rejects paths containing null bytes
 * 5. Resolves relative paths against the provided base directory (cwd)
 * 6. Verifies the resolved path is within the base directory (no escape)
 * 7. Checks the resolved file name matches the env file allowlist exactly
 * 8. Verifies the file exists and is a regular file
 * 9. Re-checks containment on real paths so a symlink inside the project
 *    cannot point at a file outside it
 *
 * Step 1 is fail-closed on purpose. The containment checks in 6 and 9 are both
 * gated on `baseDir`, so with `baseDir === null` the only surviving checks were
 * the allowlist and existence, i.e. any absolute path to any `*.env*` file on the
 * machine was readable, e.g. `/home/other-user/.env`. Callers derive baseDir from
 * stdinData.cwd / IDEA_PROJECT_PATH, which the Java side can legitimately fail to
 * provide, so "no base" must be an error, never a licence to read.
 *
 * @param {string} filePath - The env file path (may be relative or absolute)
 * @param {string|null} [baseDir] - Base directory to resolve relative paths against (REQUIRED)
 * @returns {Promise<{path: string|null, realPath: string|null, error: string|null, code: string|null}>}
 *   `path` is the logical (non-realpath'd) path callers keep resolving against
 *   the project root the IDE reported; `realPath` is the exact symlink-free
 *   path the containment check cleared, for the subsequent read.
 */
export async function validateEnvFilePath(filePath, baseDir) {
  // 0. Fail-closed: no base directory means we cannot prove containment.
  if (!baseDir || typeof baseDir !== 'string' || baseDir.trim() === '') {
    return validationError('NO_BASE_DIR');
  }

  // 1. Basic type/emptiness checks.
  if (!filePath || typeof filePath !== 'string') {
    return validationError('BAD_PATH_TYPE');
  }

  // 2. Null-byte injection defense.
  if (filePath.includes('\0')) {
    return validationError('NULL_BYTE');
  }

  // 2b. Normalize: trim and collapse any trailing slash.
  const normalizedInput = filePath.trim().replace(/\/+$/, '');
  if (!normalizedInput) {
    return validationError('BAD_PATH_TYPE');
  }

  // 3. Resolve relative paths against the project root; leave absolute alone.
  let candidatePath;
  if (isAbsolute(normalizedInput)) {
    candidatePath = normalize(normalizedInput);
  } else {
    candidatePath = resolve(baseDir, normalizedInput);
  }

  // 4. Containment check on the *logical* path (before realpath, so symlinks
  //    inside the project pointing outside are caught at step 9).
  const normalizedBase = normalize(baseDir);
  const normalizedCandidate = normalize(candidatePath);
  if (!normalizedCandidate.startsWith(normalizedBase + sep) && normalizedCandidate !== normalizedBase) {
    return validationError('OUTSIDE_BASE', candidatePath);
  }

  // 5. File name allowlist check (on the logical basename).
  const baseName = normalizedCandidate.split(sep).pop().toLowerCase();
  if (!isAllowedEnvFileName(baseName)) {
    return validationError('BAD_EXTENSION', candidatePath);
  }

  // 6. Existence & file type.
  let stat;
  try {
    stat = statSync(candidatePath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return validationError('NOT_FOUND', candidatePath);
    }
    return validationError('RESOLUTION_FAILED', e.message);
  }
  if (!stat.isFile()) {
    return validationError('NOT_A_FILE', candidatePath);
  }

  // 7. Realpath resolution & symlink escape check.
  let realPath;
  try {
    realPath = realpathSync(candidatePath);
  } catch (e) {
    return validationError('REALPATH_FAILED', e.message);
  }
  const realBase = realpathSync(normalizedBase);
  if (!realPath.startsWith(realBase + sep) && realPath !== realBase) {
    return validationError('SYMLINK_ESCAPE', realPath);
  }

  // All checks passed.
  return { path: candidatePath, realPath, error: null, code: null };
}

// Regex for valid env var names: POSIX-style identifiers.
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse raw .env file content into an object.
 *
 * @param {string} content - Raw .env file content
 * @returns {object} Parsed environment variables
 */
export function parseEnvContent(content) {
  const result = {};
  if (!content || typeof content !== 'string') {
    return result;
  }
  // Defensive BOM strip: in case parseEnvContent is called directly with raw file content
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }
    const eqIdx = trimmedLine.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    let key = trimmedLine.substring(0, eqIdx).trim();
    let value = trimmedLine.substring(eqIdx + 1).trim();
    key = key.replace(/^export\s+/, '').trim();
    if (key === '') {
      continue;
    }
    if (key.startsWith('#')) {
      continue;
    }
    // Defence in depth: only accept names that are actually valid environment
    // variable identifiers. Without this, "FOO BAR=x", "A-B=c" and "1KEY=v"
    // all became process.env keys. That is not directly exploitable here — the
    // classic prototype-pollution trick via `__proto__` cannot fire because the
    // values are always primitives assigned onto a fresh object, and children
    // are spawned with an options object rather than through a shell, so no
    // command injection follows — but a key that no child process could ever
    // read is pure noise, and refusing it keeps the boundary honest for any
    // future consumer that treats the map as structured data.
    if (!ENV_VAR_NAME_RE.test(key)) {
      debugLog('envLoader.parseEnvContent: skipped line with invalid env var name');
      continue;
    }
    // Strip inline comments (not inside quoted strings)
    // e.g. API_KEY=secret # production -> value = "secret"
    value = stripInlineComments(value);
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Strip inline comments from a value string, respecting quoted strings.
 * Comments start with # but only when not inside single or double quotes.
 * @param {string} value - The value string potentially containing inline comments
 * @returns {string} Value with inline comments removed and trimmed
 */
function stripInlineComments(value) {
  if (!value || typeof value !== 'string') {
    return value || '';
  }
  let result = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const nextChar = i + 1 < value.length ? value[i + 1] : '';

    if (escaped) {
      // Previous char was backslash, this char is escaped
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      // Escape sequence - mark next char as escaped
      escaped = true;
      result += char;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      result += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += char;
      continue;
    }

    if (char === '#' && !inSingleQuote && !inDoubleQuote) {
      // Found inline comment - stop processing
      break;
    }

    result += char;
  }

  return result.trim();
}

/**
 * Filter out dangerous environment variables from a parsed env map.
 *
 * @param {object} vars - Parsed environment variables
 * @returns {object} Filtered environment variables
 */
export function filterDangerousEnvVars(vars) {
  const result = {};
  if (!vars || typeof vars !== 'object') {
    return result;
  }
  for (const [key, value] of Object.entries(vars)) {
    if (isEnvFileDeniedEnvVar(key)) {
      debugLog('envLoader.filterDangerousEnvVars: denied env var from env file:', key);
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Load and parse an env file, returning filtered environment variables.
 *
 * @param {string} filePath - The env file path (relative or absolute)
 * @param {string|null} [baseDir] - Base directory to resolve relative paths against (REQUIRED)
 * @returns {Promise<object>} Filtered environment variables
 */
export async function loadEnvFile(filePath, baseDir) {
  // 0. Validate path
  const validation = await validateEnvFilePath(filePath, baseDir);
  if (validation.error) {
    // The caller only reaches here with an env file the user explicitly
    // configured, so a silent {} is indistinguishable from "the file defines no
    // variables". Warn on stderr (surfaced in the persistent idea.log) so the
    // misconfiguration is visible — but with `reason` only. `error` embeds the
    // resolved absolute path, which carries the user's home directory into a log
    // file that lives indefinitely; that detail stays behind CLAUDE_DEBUG.
    if (DEBUG) {
      debugLog('envLoader.loadEnvFile: path validation failed (%s): %s', validation.code, validation.error);
    } else {
      console.warn(
        '[envLoader] Ignoring the configured env file (' + validation.code + ': ' + validation.reason + ')'
        + ' — set CLAUDE_DEBUG=1 for details.'
      );
    }
    return {};
  }

  const { realPath } = validation;

  try {
    // Read realPath — the exact string the containment check cleared above —
    // not the logical path, so validation and read cannot diverge (TOCTOU).
    let content = await readFile(realPath, 'utf8');
    // Strip UTF-8 BOM if present, otherwise the first key becomes ﻿KEY
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }
    const parsed = parseEnvContent(content);
    const filtered = filterDangerousEnvVars(parsed);

    debugLog(
      'envLoader.loadEnvFile: loaded %d vars from %s (filtered %d denied vars)',
      Object.keys(filtered).length,
      validation.path,
      Object.keys(parsed).length - Object.keys(filtered).length
    );

    return filtered;
  } catch (e) {
    if (e.code === 'ENOENT') {
      debugLog('envLoader.loadEnvFile: file does not exist at validated path:', validation.path);
    } else {
      debugLog('envLoader.loadEnvFile: error reading file:', e.message);
    }
    return {};
  }
}

/**
 * Apply vars loaded from a .env file into process.env.
 *
 * Single shared implementation for every apply site (daemon.js,
 * claude/message-sender.js, grok/message-service.js, codex/message-service.js).
 * They used to open-code the same loop, which is exactly how the four drifted
 * apart and how PATH ended up settable from an env file in all four at once.
 *
 * Two rules, both deliberate:
 * - A var is only written when it is currently unset or empty. This is
 *   long-standing behaviour: the IDE/EnvironmentConfigurator outranks a
 *   project's .env, and it is also what makes the PATH denylist meaningful
 *   (a non-empty daemon PATH is simply never overwritten).
 * - Denied names (isEnvFileDeniedEnvVar — the DANGEROUS_ENV_VAR_SET plus PATH)
 *   never reach process.env. loadEnvFile already filters them; re-checking here
 *   keeps the invariant local to the site that actually mutates process.env.
 *
 * @param {object} envVars - Vars from loadEnvFile (or a parsed map)
 * @param {{savedEnv?: object}} [options]
 * @param {object} [options.savedEnv] - Optional map that records each var's
 *   prior value (daemon.js restores these after the request completes). Values
 *   are only recorded for vars this call actually changes.
 * @returns {{applied: string[], skipped: string[]}} Var NAMES only — never values
 */
export function applyEnvFileVars(envVars, { savedEnv } = {}) {
  const applied = [];
  const skipped = [];
  if (!envVars || typeof envVars !== 'object') {
    return { applied, skipped };
  }

  for (const [key, value] of Object.entries(envVars)) {
    if (isEnvFileDeniedEnvVar(key)) {
      // Should already be gone via filterDangerousEnvVars; belt and braces for
      // callers that build their own map.
      debugLog('envLoader.applyEnvFileVars: denied env var from env file:', key);
      skipped.push(key);
      continue;
    }
    if (key in process.env && process.env[key]) {
      skipped.push(key);
      continue;
    }
    if (savedEnv) {
      savedEnv[key] = process.env[key];
    }
    process.env[key] = value;
    applied.push(key);
  }

  // Names only. Never interpolate the value — this stderr is mirrored into a
  // persistent idea.log by the Java bridge.
  debugLog(
    'envLoader.applyEnvFileVars: applied %d vars (%s), skipped %d (%s)',
    applied.length,
    applied.join(', ') || 'none',
    skipped.length,
    skipped.join(', ') || 'none'
  );

  return { applied, skipped };
}