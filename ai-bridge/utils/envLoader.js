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
// paths and therefore stays behind CLAUDE_DEBUG; the always-on warning must be
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
 * the allowlist and existence — at which point *any* absolute path to *any*
 * `*.env*` file on the machine was readable, e.g. `/home/other-user/.env`.
 * Callers derive baseDir from stdinData.cwd / IDEA_PROJECT_PATH, which the Java
 * side can legitimately fail to provide, so "no base" must be an error, never a
 * licence to read.
 *
 * @param {string} filePath - The env file path (may be relative or absolute)
 * @param {string|null} [baseDir] - Base directory to resolve relative paths against (REQUIRED)
 * @returns {Promise<{path: string|null, realPath: string|null, error: string|null, code: string|null}>}
 *   `path` is the logical (non-realpath'd) path callers keep resolving against
 *   the project root the IDE reported; `realPath` is the exact symlink-free
 *   path the containment check cleared and that loadEnvFile actually reads.
 */
export async function validateEnvFilePath(filePath, baseDir = null) {
  if (!filePath || typeof filePath !== 'string') {
    return validationError('BAD_PATH_TYPE');
  }

  // Fail closed: without a base directory there is no containment boundary, so
  // there is nothing left to validate against (see the note above).
  if (!baseDir || typeof baseDir !== 'string') {
    return validationError('NO_BASE_DIR');
  }

  // Reject paths with null bytes (potential injection)
  if (filePath.includes('\0')) {
    return validationError('NULL_BYTE');
  }

  let resolvedPath;
  try {
    // Normalize the path
    const normalized = normalize(filePath);

    // Relative paths resolve against the project dir; absolute paths are taken
    // as-is and must still pass the containment checks below.
    resolvedPath = isAbsolute(normalized)
      ? resolve(normalized)
      : resolve(resolve(baseDir), normalized);

    // Path traversal check: the resolved path must stay within the project dir.
    const normalizedBase = resolve(baseDir);
    // Must start with base + separator, or be exactly equal
    const isWithinBase = resolvedPath === normalizedBase ||
      resolvedPath.startsWith(normalizedBase + sep);
    if (!isWithinBase) {
      return validationError('OUTSIDE_BASE', resolvedPath);
    }
  } catch (e) {
    return validationError('RESOLUTION_FAILED', e.message);
  }

  // Validate file name against the allowlist. The *logical* name is checked —
  // that is the name the user configured — while containment below is checked
  // on real paths.
  const lowerPath = resolvedPath.toLowerCase();
  const baseName = lowerPath.substring(lowerPath.lastIndexOf(sep) + 1);
  if (!isAllowedEnvFileName(baseName)) {
    return validationError('BAD_EXTENSION', resolvedPath);
  }

  // Symlink escape check: a `.env` symlink sitting inside the project can point
  // at ~/.ssh/id_rsa or any other file outside it, which defeats the textual
  // containment check above. Re-validate on real paths — both sides must be
  // realpath'd because macOS resolves /var -> /private/var, so a base dir taken
  // from the IDE never matches its realpath.
  //
  // This also closes a TOCTOU window: the path we validate and the path we read
  // are the same string (realPath below), rather than "validate the logical
  // path, then read whatever the logical path resolves to at open time".
  let realPath;
  let realBase;
  try {
    realPath = realpathSync(resolvedPath);
    realBase = realpathSync(resolve(baseDir));
  } catch (e) {
    // realpathSync throws ENOENT for a missing file; surface that as the
    // friendlier NOT_FOUND the callers/tests expect.
    if (e.code === 'ENOENT') {
      return validationError('NOT_FOUND', resolvedPath);
    }
    return validationError('REALPATH_FAILED', e.message);
  }

  if (realPath !== realBase && !realPath.startsWith(realBase + sep)) {
    return validationError('SYMLINK_ESCAPE', realPath);
  }

  // The real path must exist and be a regular file (a directory named .env
  // would otherwise blow up in readFile with a less useful error).
  if (!existsSync(realPath)) {
    return validationError('NOT_FOUND', realPath);
  }
  try {
    if (!statSync(realPath).isFile()) {
      return validationError('NOT_A_FILE', realPath);
    }
  } catch (e) {
    return validationError('NOT_FOUND', e.message);
  }

  return { path: resolvedPath, realPath, error: null, reason: null, code: null };
}

/**
 * Load a .env file and return a key-value map of environment variables.
 *
 * Security: validates the file path against the project directory (fail-closed
 * when no directory is known) and filters out environment variable names that
 * could enable code injection (e.g., NODE_OPTIONS, LD_PRELOAD, PATH).
 *
 * @param {string} filePath - Path to the .env file (relative or absolute)
 * @param {string|null} [baseDir] - Base directory for path validation (REQUIRED)
 * @returns {Promise<object>} Map of env variable names to their values (denied vars filtered)
 */
export async function loadEnvFile(filePath, baseDir = null) {
  // Validate and resolve the file path
  const { path: validatedPath, realPath, error, reason, code } = await validateEnvFilePath(filePath, baseDir);

  if (!validatedPath) {
    // The caller only reaches here with an env file the user explicitly
    // configured, so a silent {} is indistinguishable from "the file defines no
    // variables". Warn on stderr (surfaced in the persistent idea.log) so the
    // misconfiguration is visible — but with `reason` only. `error` embeds the
    // resolved absolute path, which carries the user's home directory into a log
    // file that lives indefinitely; that detail stays behind CLAUDE_DEBUG.
    if (DEBUG) {
      debugLog('envLoader.loadEnvFile: path validation failed (%s): %s', code, error);
    } else {
      console.warn(
        '[envLoader] Ignoring the configured env file (' + code + ': ' + reason + ')'
        + ' — set CLAUDE_DEBUG=1 for details.'
      );
    }
    return {};
  }

  try {
    // Read realPath — the exact string the containment check cleared above —
    // not the logical path, so validation and read cannot diverge (TOCTOU).
    const content = await readFile(realPath, 'utf8');
    // Strip UTF-8 BOM if present, otherwise the first key becomes ﻿KEY
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }
    const parsed = parseEnvContent(content);
    const filtered = filterDangerousEnvVars(parsed);

    debugLog(
      'envLoader.loadEnvFile: loaded %d vars from %s (filtered %d denied vars)',
      Object.keys(filtered).length,
      validatedPath,
      Object.keys(parsed).length - Object.keys(filtered).length
    );

    return filtered;
  } catch (e) {
    if (e.code === 'ENOENT') {
      debugLog('envLoader.loadEnvFile: file does not exist at validated path:', validatedPath);
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
    applied.join(', '),
    skipped.length,
    skipped.join(', ')
  );

  return { applied, skipped };
}

/**
 * Filter out environment variable names that must never be taken from a .env
 * file. This is the union of the process-hijack set (NODE_OPTIONS, LD_PRELOAD,
 * DYLD_*, PYTHONPATH, …) and the env-file-only extras (PATH) — see
 * isEnvFileDeniedEnvVar.
 *
 * NOTE: this is the .env-file gate only. The params.env / settings.json path
 * uses isDangerousEnvVar directly so the IDE-supplied PATH keeps working.
 *
 * @param {object} envVars - Raw env vars from .env file
 * @returns {object} Env vars with denied ones filtered out
 */
export function filterDangerousEnvVars(envVars) {
  // Guard against null/undefined input to prevent TypeError from Object.entries
  if (!envVars || typeof envVars !== 'object') {
    return {};
  }
  const result = {};
  const filtered = [];

  for (const [key, value] of Object.entries(envVars)) {
    if (isEnvFileDeniedEnvVar(key)) {
      filtered.push(key);
      debugLog('envLoader.loadEnvFile: filtered denied env var:', key);
      continue;
    }
    result[key] = value;
  }

  if (filtered.length > 0 && DEBUG) {
    // Names only, and debug-gated: a project's .env may legitimately contain
    // secrets, and this text lands in a persistent idea.log.
    console.warn('[SECURITY] Filtered denied env vars from .env file:', JSON.stringify(filtered));
  }

  return result;
}

// Valid environment variable identifier: [A-Za-z_][A-Za-z0-9_]*
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse .env content string into a key-value map.
 * Handles comments (#), blank lines, quoted values, and exports.
 * Does NOT filter dangerous env vars — use loadEnvFile for that.
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
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
