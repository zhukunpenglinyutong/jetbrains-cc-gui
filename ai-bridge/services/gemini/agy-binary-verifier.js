import { spawnSync } from 'node:child_process';
import {
  decodeCliOutput,
  resolveCliSpawn,
  resolveGeminiCliPath,
} from '../../utils/cli-path.js';

export const AGY_MIN_VERSION = '1.1.15';
export const AGY_REQUIRED_HELP_FLAGS = ['--conversation', '--effort', '--sandbox', 'models'];

// Match a required flag/subcommand as a whole word in help text. A bare
// substring check would let near-misses pass ('models' inside
// '--show-models', '--conversation' inside '--conversation-mode').
function helpTextContainsFlag(helpText, flag) {
  const escaped = String(flag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}(?=$|[^\\w-])`).test(helpText);
}

/**
 * Parses a semantic version string into its major, minor, patch, prerelease, and build components.
 *
 * @param {unknown} str Version string to parse (optionally prefixed with 'v').
 * @returns {{ major: number, minor: number, patch: number, prerelease: string|null, build: string|null, raw: string }|null} parsed semver object or null if invalid
 */
export function parseSemver(str) {
  const trimmed = String(str ?? '').trim();
  const match = trimmed.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    build: match[5] || null,
    raw: trimmed,
  };
}

/**
 * Compares two semantic version strings or parsed version objects, returning NaN when either input is invalid.
 *
 * @param {string|object} v1 First version string or parsed semver object.
 * @param {string|object} v2 Second version string or parsed semver object.
 * @returns {number} negative if v1 < v2, 0 if equal, positive if v1 > v2, or NaN if either version is invalid
 */
export function compareSemver(v1, v2) {
  const s1 = typeof v1 === 'string' ? parseSemver(v1) : v1;
  const s2 = typeof v2 === 'string' ? parseSemver(v2) : v2;
  if (!s1 || !s2) return NaN;
  if (
    !Number.isFinite(s1?.major) || !Number.isFinite(s2?.major)
    || !Number.isFinite(s1?.minor) || !Number.isFinite(s2?.minor)
    || !Number.isFinite(s1?.patch) || !Number.isFinite(s2?.patch)
  ) {
    return NaN;
  }
  if (s1.major !== s2.major) return s1.major - s2.major;
  if (s1.minor !== s2.minor) return s1.minor - s2.minor;
  if (s1.patch !== s2.patch) return s1.patch - s2.patch;
  if (s1.prerelease && !s2.prerelease) return -1;
  if (!s1.prerelease && s2.prerelease) return 1;
  if (s1.prerelease && s2.prerelease) return comparePrerelease(s1.prerelease, s2.prerelease);
  return 0;
}

// Compare dot-separated prerelease identifiers per semver.org: numeric
// identifiers compare numerically (alpha.10 > alpha.9), numeric sorts below
// alphanumeric, and a shorter identifier list sorts below a longer prefix
// match (alpha < alpha.1).
function comparePrerelease(a, b) {
  const partsA = a.split('.');
  const partsB = b.split('.');
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i];
    const y = partsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^[0-9]+$/.test(x);
    const yNumeric = /^[0-9]+$/.test(y);
    if (xNumeric && yNumeric) {
      const delta = parseInt(x, 10) - parseInt(y, 10);
      if (delta !== 0) return delta;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else {
      const cmp = x.localeCompare(y);
      if (cmp !== 0) return cmp < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Validates that a resolved binary is the genuine Antigravity CLI (agy) and meets the minimum version requirement.
 *
 * @param {string} [bin] Optional binary path or command name to probe.
 * @param {object} [options] Optional probe configuration (env, timeout, forceWindows, spawnSyncFn).
 * @returns {{ ok: boolean, available: boolean, version?: string, path?: string, error?: string, reason?: string }} verification outcome for the agy binary
 */
export function verifyAgyBinary(bin, options = {}) {
  const resolvedBin = bin || resolveGeminiCliPath();
  const opts = options || {};
  // spawnSync treats a falsy timeout as "no timeout" - clamp non-positive
  // values to the default so a hung CLI cannot block the probe forever.
  const probeTimeout = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : 5000;
  if (!resolvedBin) {
    return {
      ok: false,
      available: false,
      reason: 'not_found',
      error: 'Antigravity CLI (agy) binary not found. Install it or set GEMINI_BIN (or GEMINI_PATH / GEMINI_CLI_PATH) to the binary path.',
    };
  }

  // 1. Probe version: <bin> --version
  let versionProc;
  try {
    const spawnInfo = resolveCliSpawn(
      resolvedBin,
      ['--version'],
      {
        env: opts.env || process.env,
        timeout: probeTimeout,
        encoding: 'utf8',
      },
      opts.forceWindows,
    );
    const spawnSyncFn = opts.spawnSyncFn || spawnSync;
    versionProc = spawnSyncFn(spawnInfo.file, spawnInfo.args, spawnInfo.options);
  } catch (err) {
    return {
      ok: false,
      available: false,
      path: resolvedBin,
      reason: 'spawn_failed',
      error: `Failed to spawn CLI (${resolvedBin}): ${err?.message || err}`,
    };
  }

  if (versionProc.error) {
    const isEnoent = versionProc.error.code === 'ENOENT';
    const isTimeout = versionProc.error.code === 'ETIMEDOUT' || versionProc.error.signal === 'SIGTERM';
    return {
      ok: false,
      available: false,
      path: resolvedBin,
      reason: isEnoent ? 'not_found' : (isTimeout ? 'timeout' : 'spawn_failed'),
      error: isEnoent
        ? `Antigravity CLI not found at ${resolvedBin}. Install it or set GEMINI_BIN (or GEMINI_PATH / GEMINI_CLI_PATH).`
        : (isTimeout
          ? `Probe timed out while executing Antigravity CLI (${resolvedBin}) with --version.`
          : `Failed to probe CLI (${resolvedBin}): ${versionProc.error.message}`),
    };
  }

  if (versionProc.status !== 0 || versionProc.signal) {
    // The binary ran but crashed/was killed - an environment or runtime
    // failure, not proof of a lookalike. Report it as its own cause.
    const stderrTail = decodeCliOutput(versionProc.stderr).trim().slice(0, 200);
    const crashDetail = versionProc.signal
      ? `terminated by signal ${versionProc.signal}`
      : `exited with code ${versionProc.status}`;
    return {
      ok: false,
      available: false,
      path: resolvedBin,
      reason: 'spawn_failed',
      error: `Binary "${resolvedBin}" ${crashDetail} on --version probe${stderrTail ? `: ${stderrTail}` : ''}. If using a custom installation, set GEMINI_BIN (or GEMINI_PATH / GEMINI_CLI_PATH) to the Antigravity 'agy' binary path.`,
    };
  }

  // Accept a clean semver on any single output line - future versions may
  // print an update notice alongside the version without being lookalikes.
  const rawVersionOutput = decodeCliOutput(versionProc.stdout).trim();
  const semverLine = rawVersionOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => parseSemver(line) !== null) || null;
  const parsedVersion = semverLine ? parseSemver(semverLine) : null;
  if (!parsedVersion) {
    return {
      ok: false,
      available: false,
      path: resolvedBin,
      reason: 'lookalike',
      error: `Binary "${resolvedBin}" does not appear to be the Antigravity CLI (unexpected version output: "${rawVersionOutput.slice(0, 120)}"). Set GEMINI_BIN (or GEMINI_PATH / GEMINI_CLI_PATH) to the Antigravity 'agy' binary path.`,
    };
  }

  if (!(compareSemver(parsedVersion, AGY_MIN_VERSION) >= 0)) {
    return {
      ok: false,
      available: false,
      version: parsedVersion.raw,
      path: resolvedBin,
      reason: 'unsupported_version',
      error: `Antigravity CLI version ${parsedVersion.raw} is below the minimum required version ${AGY_MIN_VERSION}. Please update with 'agy update' or visit https://antigravity.google/docs`,
    };
  }

  // 2. Probe help: <bin> --help
  let helpProc;
  try {
    const spawnInfo = resolveCliSpawn(
      resolvedBin,
      ['--help'],
      {
        env: opts.env || process.env,
        timeout: probeTimeout,
        encoding: 'utf8',
      },
      opts.forceWindows,
    );
    const spawnSyncFn = opts.spawnSyncFn || spawnSync;
    helpProc = spawnSyncFn(spawnInfo.file, spawnInfo.args, spawnInfo.options);
  } catch (err) {
    return {
      ok: false,
      available: false,
      path: resolvedBin,
      reason: 'spawn_failed',
      error: `Failed to run --help on CLI (${resolvedBin}): ${err?.message || err}`,
    };
  }

  if (helpProc.error) {
    const isEnoent = helpProc.error.code === 'ENOENT';
    const isTimeout = helpProc.error.code === 'ETIMEDOUT' || helpProc.error.signal === 'SIGTERM';
    return {
      ok: false,
      available: false,
      path: resolvedBin,
      reason: isEnoent ? 'not_found' : (isTimeout ? 'timeout' : 'spawn_failed'),
      error: isEnoent
        ? `Antigravity CLI not found at ${resolvedBin}. Install it or set GEMINI_BIN (or GEMINI_PATH / GEMINI_CLI_PATH).`
        : (isTimeout
          ? `Probe timed out while executing Antigravity CLI (${resolvedBin}) with --help.`
          : `Failed to run --help on CLI (${resolvedBin}): ${helpProc.error.message}`),
    };
  }

  if (helpProc.signal || helpProc.status === null) {
    return {
      ok: false,
      available: false,
      path: resolvedBin,
      reason: 'spawn_failed',
      error: `Binary "${resolvedBin}" terminated by signal ${helpProc.signal || 'unknown'} on --help probe.`,
    };
  }

  if (helpProc.status !== 0) {
    return {
      ok: false,
      available: false,
      path: resolvedBin,
      reason: 'lookalike',
      error: `Binary "${resolvedBin}" exited with code ${helpProc.status} on --help probe. Set GEMINI_BIN (or GEMINI_PATH / GEMINI_CLI_PATH) to the Antigravity 'agy' binary path.`,
    };
  }

  const helpText = `${decodeCliOutput(helpProc.stdout)}\n${decodeCliOutput(helpProc.stderr)}`;
  for (const requiredFlag of AGY_REQUIRED_HELP_FLAGS) {
    if (!helpTextContainsFlag(helpText, requiredFlag)) {
      return {
        ok: false,
        available: false,
        path: resolvedBin,
        reason: 'lookalike',
        error: `Binary "${resolvedBin}" is missing required flag/subcommand "${requiredFlag}". It does not appear to be the Antigravity CLI. Set GEMINI_BIN (or GEMINI_PATH / GEMINI_CLI_PATH) to the Antigravity 'agy' binary path.`,
      };
    }
  }

  return {
    ok: true,
    available: true,
    version: parsedVersion.raw,
    path: resolvedBin,
  };
}
