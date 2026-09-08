/**
 * Shared CLI binary path resolution for headless CLI providers (Grok / Kimi / OpenCode / PI).
 *
 * Priority:
 * 1. Explicit env overrides
 * 2. PATH lookup (`which` / `where`)
 * 3. Common home install candidates
 * 4. Bare binary name fallback
 *
 * Windows note: npm global installs create three shims (`pi`, `pi.cmd`, `pi.ps1`).
 * `where pi` often lists the extensionless bash wrapper first. Node's
 * `spawn()` cannot CreateProcess that file (ENOENT). Prefer `.cmd` / `.exe`
 * and launch `.cmd`/`.bat` via `cmd.exe /d /s /c` (see `resolveCliSpawn`).
 */

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute, win32 as pathWin32 } from 'path';
import { execFileSync, execSync, spawnSync } from 'child_process';

/** Extensions that can be launched on Windows (`.cmd`/`.bat` via cmd.exe). */
const WINDOWS_SPAWNABLE_EXT = /\.(cmd|bat|exe)$/i;
/** Prefer real PE binaries, then cmd shims, over extensionless npm wrappers. */
const WINDOWS_SPAWNABLE_PRIORITY = ['.exe', '.cmd', '.bat'];

function stripOuterQuotes(value) {
  const s = String(value ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Windows npm global installs only ship a `.cmd` / `.bat` shim (no `.exe`),
 * and Node cannot CreateProcess those without going through `cmd.exe`.
 * @param {string} bin - resolved binary path or bare name
 * @returns {boolean}
 */
export function isWindowsCmdShim(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(stripOuterQuotes(bin));
}

/**
 * Quote one argv token for `cmd.exe /s /c`. Doubles quotes and percents so a
 * spaced path or a `%VAR%` fragment cannot be re-parsed / expanded.
 * @param {unknown} value
 * @returns {string}
 */
export function quoteCmdArg(value) {
  return `"${String(value ?? '').replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

function prependPathDir(env, dir) {
  if (!dir || dir === '.') return env;
  const current = env.PATH || env.Path || '';
  const parts = current ? current.split(';') : [];
  if (!parts.includes(dir)) parts.unshift(dir);
  const merged = parts.join(';');
  env.PATH = merged;
  env.Path = merged;
  return env;
}

/**
 * Build a spawn/spawnSync invocation that can run Windows npm `.cmd`/`.bat`
 * shims without `shell: true`.
 *
 * Node's `shell: true` concatenates `file + ' ' + args` and does **not** quote
 * `file`. A shim under npm's default prefix (`C:\Program Files\nodejs\opencode.cmd`)
 * is then re-parsed by cmd as `'C:\Program'` (exit code 1). Passing a
 * pre-quoted file into `shell: true` is also fragile: Node wraps the whole
 * command again (`cmd /s /c "…"`), and a second quote pair becomes `""C:\Program`.
 *
 * Instead, launch `cmd.exe /d /s /c` ourselves with `windowsVerbatimArguments`
 * and invoke the shim by **basename** after prepending its directory to PATH.
 * That keeps spaces out of the command token entirely.
 *
 * @param {string} bin
 * @param {string[]} [args]
 * @param {import('child_process').SpawnOptions & { redirectTo?: string }} [extraOptions]
 * @param {boolean} [forceWindows] - test hook; defaults to process.platform === 'win32'
 * @returns {{ file: string, args: string[], options: object }}
 */
export function resolveCliSpawn(
  bin,
  args = [],
  extraOptions = {},
  forceWindows = process.platform === 'win32',
) {
  const { redirectTo, ...options } = extraOptions || {};
  const normalized = stripOuterQuotes(bin);
  const isShim = forceWindows && /\.(cmd|bat)$/i.test(normalized);
  // `.cmd`/`.bat` must go through cmd (CVE-2024-27980). File-redirect
  // recovery for Bun-on-Windows also needs cmd, including `.exe` paths.
  const needsCmd = isShim || (forceWindows && Boolean(redirectTo));

  if (needsCmd) {
    const looksLikePath = pathWin32.isAbsolute(normalized) || /[\\/]/.test(normalized);
    // Invoke shims by basename so `C:\Program Files\...` never appears as the
    // command token. Keep the full path for real `.exe` binaries.
    const invokeName = isShim && looksLikePath ? pathWin32.basename(normalized) : normalized;
    const env = prependPathDir(
      { ...(options.env || process.env) },
      looksLikePath ? pathWin32.dirname(normalized) : '',
    );
    let command = [invokeName, ...args].map(quoteCmdArg).join(' ');
    if (redirectTo) command += ` > ${quoteCmdArg(redirectTo)}`;
    return {
      file: env.ComSpec || env.COMSPEC || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      options: {
        ...options,
        env,
        shell: false,
        windowsVerbatimArguments: true,
        windowsHide: options.windowsHide !== false,
      },
    };
  }

  return {
    file: normalized,
    args,
    options: {
      ...options,
      ...(forceWindows ? { windowsHide: options.windowsHide !== false } : {}),
    },
  };
}

/**
 * Decode CLI stdout/stderr. Windows `cmd` often emits GBK/CP936, which Node
 * turns into U+FFFD replacement characters when forced to UTF-8.
 * @param {string|Buffer|null|undefined} value
 * @returns {string}
 */
export function decodeCliOutput(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  for (const label of ['gbk', 'gb18030']) {
    try {
      return new TextDecoder(label).decode(buf);
    } catch {
      // Node builds without full ICU cannot decode GBK; try the next label.
    }
  }
  return utf8;
}

/**
 * Pick the best match from `where` output lines on Windows.
 * Prefer `.exe` / `.cmd` / `.bat` over extensionless npm bash shims.
 *
 * @param {string[]|null|undefined} matches
 * @returns {string|null}
 */
export function selectWindowsWhereMatch(matches) {
  const lines = (Array.isArray(matches) ? matches : [])
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  for (const ext of WINDOWS_SPAWNABLE_PRIORITY) {
    const hit = lines.find((line) => line.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return lines[0];
}

/**
 * If `bin` is an absolute/relative path without a spawnable Windows extension
 * and a sibling `.exe`/`.cmd`/`.bat` exists, return that sibling.
 *
 * Bare names (`pi`) are left unchanged so PATH+PATHEXT still apply at spawn.
 *
 * @param {string} bin
 * @param {(path: string) => boolean} [existsFn]
 * @param {boolean} [forceWindows] - test hook; defaults to process.platform === 'win32'
 * @returns {string}
 */
export function resolveWindowsSpawnableBin(
  bin,
  existsFn = pathExists,
  forceWindows = process.platform === 'win32',
) {
  if (!forceWindows || typeof bin !== 'string') return bin;
  const trimmed = bin.trim();
  if (!trimmed) return bin;
  if (WINDOWS_SPAWNABLE_EXT.test(trimmed)) return trimmed;

  // Bare command names: let PATHEXT / shell resolve; do not invent a path.
  const looksLikePath = isAbsolute(trimmed)
    || trimmed.includes('/')
    || trimmed.includes('\\')
    || /^[A-Za-z]:/.test(trimmed);
  if (!looksLikePath) return trimmed;

  for (const ext of WINDOWS_SPAWNABLE_PRIORITY) {
    const candidate = `${trimmed}${ext}`;
    if (existsFn(candidate)) return candidate;
  }
  return trimmed;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function pathExists(candidate) {
  try {
    return typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * Shells allowed for login-env probing: `$SHELL` is attacker-influenced, so only
 * standard system/Homebrew shell binaries may be invoked.
 */
const ALLOWED_LOGIN_SHELLS = new Set([
  '/bin/zsh', '/bin/bash', '/bin/sh',
  '/usr/bin/zsh', '/usr/bin/bash', '/usr/bin/sh',
  '/usr/local/bin/zsh', '/usr/local/bin/bash',
  '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/bash',
  '/usr/local/bin/fish', '/opt/homebrew/bin/fish',
]);

/**
 * Resolve a binary through the user's login shell (non-Windows only). Returns
 * an absolute path or null. The binary name is an internal constant; the result
 * is validated against the filesystem before use.
 *
 * @param {string} binaryName
 * @param {string} [shellOverride] - test hook; defaults to allowlisted $SHELL
 * @returns {string|null}
 */
export function whichViaLoginShell(binaryName, shellOverride) {
  if (process.platform === 'win32') return null;
  if (!/^[a-z0-9._-]+$/i.test(String(binaryName || ''))) return null;
  let shell = shellOverride || process.env.SHELL || '';
  if (!ALLOWED_LOGIN_SHELLS.has(shell)) {
    shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find((candidate) => pathExists(candidate)) || '';
  }
  if (!shell) return null;
  const fish = shell.endsWith('fish');
  // -l -i: nvm/fnm/mise only export PATH from interactive login rc files.
  const args = fish
    ? ['-c', `command -v ${binaryName}`]
    : ['-l', '-i', '-c', `command -v ${binaryName}`];
  try {
    const output = execFileSync(shell, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
      timeout: 8000,
    });
    const first = String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first && first.startsWith('/') && pathExists(first)) return first;
    return null;
  } catch {
    return null;
  }
}

function whichOnPath(binaryName) {
  try {
    if (process.platform === 'win32') {
      // Prefer execFile so the binary name is not re-parsed by a shell.
      // `where` lists every PATHEXT match; the extensionless npm shim is often first
      // and cannot be spawned — selectWindowsWhereMatch prefers .cmd/.exe.
      let output;
      try {
        output = execFileSync('where.exe', [binaryName], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: process.env,
          windowsHide: true,
        });
      } catch {
        // Fallback for systems where where.exe is not on PATH of the IDE process.
        output = execSync(`where ${binaryName}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: process.env,
          windowsHide: true,
        });
      }
      const lines = String(output || '').split(/\r?\n/);
      return selectWindowsWhereMatch(lines);
    }

    const output = execFileSync('which', [binaryName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    const first = String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.binaryName - e.g. "grok" | "kimi" | "opencode"
 * @param {string[]} [options.envKeys] - env var names for path override
 * @param {string[]} [options.homeCandidates] - absolute-ish candidates under $HOME
 *   (use `{home}` placeholder or pass full relative segments)
 * @returns {string}
 */
export function resolveCliPath({ binaryName, envKeys = [], homeCandidates = [] }) {
  const win = process.platform === 'win32';
  // npm global installs on Windows ship `.cmd` shims, not `.exe`.
  const exeNames = win
    ? [`${binaryName}.cmd`, `${binaryName}.bat`, `${binaryName}.exe`, binaryName]
    : [binaryName];

  const envOverride = firstNonEmpty(...envKeys.map((key) => process.env[key]));
  if (envOverride) {
    return resolveWindowsSpawnableBin(envOverride);
  }

  // `where <name>` (no extension) honors PATHEXT; we then prefer .cmd/.exe.
  const fromPath = whichOnPath(binaryName);
  if (fromPath) return resolveWindowsSpawnableBin(fromPath);

  const home = homedir();
  for (const template of homeCandidates) {
    for (const exeName of exeNames) {
      const resolved = template
        .replace('{home}', home)
        .replace('{localAppData}', process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
        .replace('{bin}', exeName)
        .replace('{name}', binaryName);
      if (pathExists(resolved)) return resolveWindowsSpawnableBin(resolved);
    }
  }

  // Version managers (nvm/fnm/mise/asdf) and other well-known bin dirs. This
  // must stay in sync with the spawn PATH enrichment in commonCliBinDirs so a
  // resolved path can actually launch.
  for (const dir of commonCliBinDirs(home)) {
    for (const exeName of exeNames) {
      const resolved = join(dir, exeName);
      if (pathExists(resolved)) return resolveWindowsSpawnableBin(resolved);
    }
  }

  // Last resort: the user's login shell. IDE/daemon processes can run with a
  // minimal PATH, so CLIs installed via nvm/fnm/mise/asdf or custom prefixes
  // only become visible once the login rc files are sourced.
  const fromShell = whichViaLoginShell(binaryName);
  if (fromShell) return resolveWindowsSpawnableBin(fromShell);

  return binaryName;
}

/**
 * Prepend extra bin dirs to PATH when missing (IDE PATH is often sparse).
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} binDirs
 */
export function enrichPathWithBinDirs(env, binDirs = []) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  let current = env[pathKey] || env.PATH || '';
  const parts = current ? current.split(sep) : [];
  for (const dir of binDirs) {
    if (dir && !parts.includes(dir)) {
      parts.unshift(dir);
    }
  }
  env[pathKey] = parts.join(sep);
  if (pathKey !== 'PATH') {
    env.PATH = env[pathKey];
  }
}

export function resolveGrokCliPath() {
  return resolveCliPath({
    binaryName: 'grok',
    envKeys: ['GROK_BIN', 'GROK_PATH', 'GROK_CLI_PATH'],
    homeCandidates: [
      '{home}/.grok/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
}

/**
 * Node version-manager global bin dirs. IDEs launched from Finder/launchd get
 * a sparse PATH, so npm CLIs installed under nvm/fnm/mise/asdf version dirs are
 * invisible unless the login shell is sourced — and the login-shell fallback is
 * fragile (slow or stdin-blocking rc files). Scan the well-known roots directly.
 *
 * Each dir also contains its own `node`, so adding these to the spawn PATH lets
 * `#!/usr/bin/env node` npm shims launch. Newest versions first.
 *
 * @param {string} [home]
 * @returns {string[]}
 */
export function versionManagerBinDirs(home = homedir()) {
  const dirs = [];
  if (!home) return dirs;
  if (process.platform === 'win32') return dirs;
  // Static single-node managers (bin dir sits next to the managed node).
  dirs.push(
    join(home, '.hermes', 'node', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.fnm', 'aliases', 'default', 'bin'),
    join(home, '.nvmd', 'bin'),
  );
  // Per-version managers: one global bin dir per installed node version.
  const versionedRoots = [
    { root: join(home, '.nvm', 'versions', 'node'), binSub: ['bin'] },
    { root: join(home, '.local', 'share', 'fnm', 'node-versions'), binSub: ['installation', 'bin'] },
    { root: join(home, '.local', 'share', 'mise', 'installs', 'node'), binSub: ['bin'] },
    { root: join(home, '.asdf', 'installs', 'nodejs'), binSub: ['bin'] },
  ];
  for (const { root, binSub } of versionedRoots) {
    for (const version of listVersionDirsDesc(root)) {
      dirs.push(join(root, version, ...binSub));
    }
  }
  return dirs;
}

/** Directory names under `root` that look like versions, newest first. */
function listVersionDirsDesc(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => /\d/.test(name))
    .sort(compareVersionNamesDesc);
}

/** Numeric-descending compare for names like `v22.22.3` / `24.11.1`. */
function compareVersionNamesDesc(a, b) {
  const pa = a.split(/\D+/).filter(Boolean).map(Number);
  const pb = b.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Common user-level CLI install dirs (IDE PATH is often sparse / no login shell).
 * Used both for binary resolution and spawn PATH enrichment.
 */
export function commonCliBinDirs(home = homedir()) {
  const dirs = [];
  if (!home) return dirs;
  dirs.push(
    join(home, '.kimi-code', 'bin'),
    join(home, '.kimi', 'bin'),
    join(home, '.moonshot', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.local', 'share', 'opencode', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.pi', 'bin'),
    join(home, '.omp', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.minimax', 'bin'),
    join(home, '.minimax-code'),
    join(home, '.claude', 'bin'),
    join(home, '.yarn', 'bin'),
    // pnpm global installs (PNPM_HOME defaults per platform)
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
  );
  // Version-manager dirs carry both the npm-installed CLI shims and the `node`
  // those `#!/usr/bin/env node` shims need at spawn time.
  dirs.push(...versionManagerBinDirs(home));
  if (process.platform === 'win32') {
    // npm global bin dir on Windows (e.g. C:\Users\<user>\AppData\Roaming\npm).
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    dirs.push(join(appData, 'npm'));
    // OMP Windows native installer (e.g. C:\Users\<user>\AppData\Local\omp).
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    dirs.push(join(localAppData, 'omp'));
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    dirs.push(join(programFiles, 'nodejs'));
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (programFilesX86) dirs.push(join(programFilesX86, 'nodejs'));
  }
  return dirs;
}

export function resolveKimiCliPath() {
  return resolveCliPath({
    binaryName: 'kimi',
    envKeys: ['KIMI_BIN', 'KIMI_PATH', 'KIMI_CLI_PATH', 'KIMI_CODE_BIN'],
    homeCandidates: [
      // Official kimi-code install location (current)
      '{home}/.kimi-code/bin/{bin}',
      '{home}/.local/bin/{bin}',
      // Legacy install paths
      '{home}/.kimi/bin/{bin}',
      '{home}/.moonshot/bin/{bin}',
    ],
  });
}

export function resolveOpenCodeCliPath() {
  return resolveCliPath({
    binaryName: 'opencode',
    envKeys: ['OPENCODE_BIN', 'OPENCODE_PATH', 'OPENCODE_CLI_PATH'],
    homeCandidates: [
      '{home}/.opencode/bin/{bin}',
      '{home}/.local/bin/{bin}',
      '{home}/.local/share/opencode/bin/{bin}',
    ],
  });
}

export function resolvePiCliPath() {
  return resolveCliPath({
    binaryName: 'pi',
    envKeys: ['PI_BIN', 'PI_PATH', 'PI_CLI_PATH'],
    homeCandidates: [
      '{home}/.pi/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
}

export function resolveOmpCliPath() {
  return resolveCliPath({
    binaryName: 'omp',
    envKeys: ['OMP_BIN', 'OMP_PATH', 'OMP_CLI_PATH'],
    homeCandidates: [
      '{home}/.omp/bin/{bin}',
      '{home}/.bun/bin/{bin}',
      // Windows native installer: %LOCALAPPDATA%\omp\omp.exe
      '{localAppData}/omp/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
}

export function resolveMiniMaxCliPath() {
  // Official installer exposes `minimax`; npm global installs expose `mcode`.
  // Try the official name first, then fall back to the npm bin name.
  const envKeys = ['MINIMAX_BIN', 'MINIMAX_PATH', 'MINIMAX_CLI_PATH', 'MCODE_BIN'];
  const minimax = resolveCliPath({
    binaryName: 'minimax',
    envKeys,
    homeCandidates: [
      '{home}/.minimax/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
  if (minimax !== 'minimax') {
    return minimax;
  }
  const mcode = resolveCliPath({
    binaryName: 'mcode',
    envKeys,
    homeCandidates: [
      '{home}/.minimax-code/{bin}',
      '{home}/.minimax/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
  // resolveCliPath returns the bare name when nothing resolved; prefer mcode's
  // result (it may be a real path) and only fall back to `minimax` at the very end.
  return mcode !== 'mcode' ? mcode : minimax;
}

export function resolveGeminiCliPath() {
  return resolveCliPath({
    binaryName: 'agy',
    envKeys: ['GEMINI_BIN', 'GEMINI_PATH', 'GEMINI_CLI_PATH'],
    homeCandidates: [
      '{home}/.local/bin/{bin}',
    ],
  });
}

export const AGY_MIN_VERSION = '1.1.15';
export const AGY_REQUIRED_HELP_FLAGS = ['--conversation', '--effort', '--sandbox', 'models'];

/**
 * Match a required flag/subcommand as a whole word in help text. A bare
 * substring check would let near-misses pass ('models' inside
 * '--show-models', '--conversation' inside '--conversation-mode').
 */
function helpTextContainsFlag(helpText, flag) {
  const escaped = String(flag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}(?=$|[^\\w-])`).test(helpText);
}

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

export function compareSemver(v1, v2) {
  const s1 = typeof v1 === 'string' ? parseSemver(v1) : v1;
  const s2 = typeof v2 === 'string' ? parseSemver(v2) : v2;
  if (!s1 || !s2) return 0;
  if (!Number.isFinite(s1?.major) || !Number.isFinite(s2?.major)) return 0;
  if (s1.major !== s2.major) return s1.major - s2.major;
  if (s1.minor !== s2.minor) return s1.minor - s2.minor;
  if (s1.patch !== s2.patch) return s1.patch - s2.patch;
  if (s1.prerelease && !s2.prerelease) return -1;
  if (!s1.prerelease && s2.prerelease) return 1;
  if (s1.prerelease && s2.prerelease) return comparePrerelease(s1.prerelease, s2.prerelease);
  return 0;
}

/**
 * Compare dot-separated prerelease identifiers per semver.org: numeric
 * identifiers compare numerically (alpha.10 > alpha.9), numeric sorts below
 * alphanumeric, and a shorter identifier list sorts below a longer prefix
 * match (alpha < alpha.1).
 */
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
 * Validate that a resolved binary is the genuine Antigravity CLI (agy)
 * and meets the minimum version requirement (>= 1.1.15 — the version that
 * added `--input-format stream-json`, the stdin prompt transport the gemini
 * message service depends on; per agy's own changelog).
 *
 * Probe (zero-cost, no tokens):
 * 1. `<bin> --version` -> exits 0 and prints clean semver (no banner)
 * 2. Version >= 1.1.15 floor
 * 3. `<bin> --help` -> contains `--conversation`, `--effort`, `--sandbox`, `models`
 *
 * @param {string} [bin]
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeout=5000]
 * @param {boolean} [options.forceWindows]
 * @param {Function} [options.spawnSyncFn] - test injection hook
 * @returns {{ ok: boolean, available: boolean, version?: string, path?: string, error?: string, reason?: string }}
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

  if (compareSemver(parsedVersion, AGY_MIN_VERSION) < 0) {
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
