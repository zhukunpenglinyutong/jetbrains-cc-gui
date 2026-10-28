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

import { existsSync, readdirSync, realpathSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, isAbsolute, win32 as pathWin32 } from 'path';
import { execFileSync, execSync } from 'child_process';

/** Extensions that can be launched on Windows (`.cmd`/`.bat` via cmd.exe). */
const WINDOWS_SPAWNABLE_EXT = /\.(cmd|bat|exe)$/i;
/** Prefer real PE binaries, then cmd shims, over extensionless npm wrappers. */
const WINDOWS_SPAWNABLE_PRIORITY = ['.exe', '.cmd', '.bat'];

/** Strip one layer of surrounding quotes from a user-configured path. */
export function stripOuterQuotes(value) {
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
 * Detect a Windows `.cmd`/`.bat` shim whose delegation target no longer
 * exists — e.g. an old install dir left on PATH whose `minimax.cmd` still
 * invokes a removed `"D:\npm-global\mcode.cmd"`. Spawning such a shim makes
 * cmd.exe print a localized "file not found" and exit 1, which surfaces as an
 * opaque send error, so CLI discovery skips these candidates.
 *
 * Only a confident answer counts as dead: the LAST quoted absolute path in
 * the script is taken as the delegation target (installers append the real
 * invocation last; earlier quoted paths are `set "VAR=..."` assignments).
 * `%~dp0` resolves against the shim's own directory; any other unresolved
 * `%VAR%` means the target cannot be verified statically, so the shim is
 * assumed alive. Scripts without a quoted absolute target are alive too.
 *
 * @param {string} bin - candidate shim path
 * @param {object} [options]
 * @param {boolean} [options.forceWindows] - test hook; defaults to win32
 * @returns {boolean} true only when the shim provably delegates to a
 *   missing file
 */
export function isDeadCmdShim(bin, { forceWindows = process.platform === 'win32' } = {}) {
  if (!forceWindows || typeof bin !== 'string') return false;
  const trimmed = stripOuterQuotes(bin).trim();
  if (!/\.(cmd|bat)$/i.test(trimmed)) return false;
  let content;
  try {
    content = readFileSync(trimmed, 'utf8');
  } catch {
    // Missing or unreadable: let the spawn produce the real error instead of
    // silently dropping the candidate.
    return false;
  }
  const quoted = content.match(/"((?:[A-Za-z]:\\|%~dp0)[^"\r\n]+)"/g) || [];
  const last = quoted[quoted.length - 1];
  if (!last) return false;
  const shimDir = pathWin32.dirname(trimmed);
  let target = last.slice(1, -1).replace(/%~dp0/gi, shimDir.endsWith('\\') ? shimDir : `${shimDir}\\`);
  if (/%[^%]*%/.test(target)) return false;
  return !pathExists(target);
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
 * and invoke the shim by its **quoted full path** after prepending its
 * directory to PATH. The full path is required, not cosmetic: a batch executed
 * via a PATH lookup by bare name receives `%0` as typed, so `%~dp0` inside the
 * script expands to the child process's CWD instead of the script's own
 * directory — every `%~dp0`-based launcher (npm shims, the mcode release
 * manager reading `<"%~dp0current"`) then reads its sibling files from the
 * wrong place and dies with cmd's localized "file not found" + exit 1.
 * `/s` strips exactly the outer quote pair, so the quoted single token
 * survives spaces and parentheses in the path.
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
    const env = prependPathDir(
      { ...(options.env || process.env) },
      looksLikePath ? pathWin32.dirname(normalized) : '',
    );
    // See the doc block: the shim MUST be invoked by its quoted full path —
    // a bare-name PATH lookup leaves %~dp0 pointing at the child's CWD.
    let command = [normalized, ...args].map(quoteCmdArg).join(' ');
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
export const ALLOWED_LOGIN_SHELLS = new Set([
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
 * @param {NodeJS.ProcessEnv} [env] - environment for $SHELL and the child probe
 * @returns {string|null}
 */
export function whichViaLoginShell(binaryName, shellOverride, env = process.env) {
  if (process.platform === 'win32') return null;
  if (!/^[a-z0-9._-]+$/i.test(String(binaryName || ''))) return null;
  let shell = shellOverride || env.SHELL || '';
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
      env,
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

/**
 * npm global installs on Windows ship `.cmd` shims, not `.exe`.
 * @param {string} binaryName
 * @returns {string[]}
 */
function candidateExeNames(binaryName) {
  return process.platform === 'win32'
    ? [`${binaryName}.cmd`, `${binaryName}.bat`, `${binaryName}.exe`, binaryName]
    : [binaryName];
}

/**
 * Every PATH match for `binaryName` in discovery order. The whole list
 * survives: an earlier, broken install must not hide a later, working one
 * (`which -a` / `where` list both).
 *
 * @param {string} binaryName
 * @param {NodeJS.ProcessEnv} [env] - environment whose PATH drives the lookup
 * @returns {string[]}
 */
function whichAllOnPath(binaryName, env = process.env) {
  try {
    if (process.platform === 'win32') {
      let output;
      try {
        output = execFileSync('where.exe', [binaryName], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env,
          windowsHide: true,
        });
      } catch {
        output = execSync(`where ${binaryName}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env,
          windowsHide: true,
        });
      }
      const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      // Keep the filesystem order stable while rating real executables first:
      // the extensionless bash shim cannot be CreateProcess'd by Node.
      const ranked = [...lines].sort((a, b) => windowsShimRank(a) - windowsShimRank(b));
      return ranked.map((line) => resolveWindowsSpawnableBin(line));
    }

    const output = execFileSync('which', ['-a', binaryName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    return String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Lower rank = more spawnable on Windows; preserves relative order within a rank. */
function windowsShimRank(candidate) {
  const index = WINDOWS_SPAWNABLE_PRIORITY.findIndex((ext) => candidate.toLowerCase().endsWith(ext));
  return index === -1 ? WINDOWS_SPAWNABLE_PRIORITY.length : index;
}

/** Stable identity for a candidate: the symlink target when it resolves. */
function candidateIdentity(candidate) {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * Ordered, deduplicated CLI candidates: env override, every PATH match, home
 * candidates, well-known bin dirs, then the login shell.
 *
 * Resolution must stay free of child-process probes (the CLI page owns version
 * detection), so only existing files are returned.
 *
 * @param {object} options
 * @param {string} options.binaryName
 * @param {string[]} [options.envKeys]
 * @param {string[]} [options.homeCandidates]
 * @param {NodeJS.ProcessEnv} [options.env] - environment for overrides and PATH
 *   lookup. Callers resolving on behalf of an untrusted request must pass a
 *   pristine snapshot — never the live, possibly injected, process.env.
 * @returns {string[]}
 */
export function listCliCandidates({ binaryName, envKeys = [], homeCandidates = [], env = process.env }) {
  const exeNames = candidateExeNames(binaryName);
  const seen = new Set();
  const candidates = [];
  const push = (candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const value = candidate.trim();
    const identity = candidateIdentity(value);
    if (seen.has(identity)) return;
    seen.add(identity);
    candidates.push(value);
  };

  const envOverride = firstNonEmpty(...envKeys.map((key) => env[key]));
  if (envOverride) {
    push(resolveWindowsSpawnableBin(envOverride));
  }

  for (const fromPath of whichAllOnPath(binaryName, env)) {
    if (pathExists(fromPath) && !isDeadCmdShim(fromPath)) push(fromPath);
  }

  const home = homedir();
  for (const template of homeCandidates) {
    for (const exeName of exeNames) {
      const resolved = template
        .replace('{home}', home)
        .replace('{localAppData}', env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
        .replace('{bin}', exeName)
        .replace('{name}', binaryName);
      const spawnable = resolveWindowsSpawnableBin(resolved);
      if (pathExists(spawnable) && !isDeadCmdShim(spawnable)) push(spawnable);
    }
  }

  for (const dir of commonCliBinDirs(home, env)) {
    for (const exeName of exeNames) {
      const resolved = join(dir, exeName);
      if (pathExists(resolved) && !isDeadCmdShim(resolved)) push(resolveWindowsSpawnableBin(resolved));
    }
  }

  const fromShell = whichViaLoginShell(binaryName, undefined, env);
  if (fromShell) {
    const spawnable = resolveWindowsSpawnableBin(fromShell);
    if (!isDeadCmdShim(spawnable)) push(spawnable);
  }

  return candidates;
}

/**
 * @param {object} options
 * @param {string} options.binaryName - e.g. "grok" | "kimi" | "opencode"
 * @param {string[]} [options.envKeys] - env var names for path override
 * @param {string[]} [options.homeCandidates] - absolute-ish candidates under $HOME
 *   (use `{home}` placeholder or pass full relative segments)
 * @param {NodeJS.ProcessEnv} [options.env] - environment for overrides and PATH
 *   lookup (see listCliCandidates for why callers pass a pristine snapshot)
 * @returns {string}
 */
export function resolveCliPath({ binaryName, envKeys = [], homeCandidates = [], env = process.env }) {
  const exeNames = candidateExeNames(binaryName);

  const envOverride = firstNonEmpty(...envKeys.map((key) => env[key]));
  if (envOverride) {
    return resolveWindowsSpawnableBin(envOverride);
  }

  // `where <name>` (no extension) honors PATHEXT; we then prefer .cmd/.exe.
  // A stale shim left on PATH by a removed install (isDeadCmdShim) is skipped
  // so discovery falls through to the well-known install dirs below.
  const aliveFromPath = whichAllOnPath(binaryName, env).find((c) => pathExists(c) && !isDeadCmdShim(c));
  if (aliveFromPath) return resolveWindowsSpawnableBin(aliveFromPath);

  const home = homedir();
  for (const template of homeCandidates) {
    for (const exeName of exeNames) {
      const resolved = template
        .replace('{home}', home)
        .replace('{localAppData}', env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
        .replace('{bin}', exeName)
        .replace('{name}', binaryName);
      const spawnable = resolveWindowsSpawnableBin(resolved);
      if (pathExists(spawnable) && !isDeadCmdShim(spawnable)) return spawnable;
    }
  }

  // Version managers (nvm/fnm/mise/asdf) and other well-known bin dirs. This
  // must stay in sync with the spawn PATH enrichment in commonCliBinDirs so a
  // resolved path can actually launch.
  for (const dir of commonCliBinDirs(home, env)) {
    for (const exeName of exeNames) {
      const resolved = join(dir, exeName);
      const spawnable = resolveWindowsSpawnableBin(resolved);
      if (pathExists(spawnable) && !isDeadCmdShim(spawnable)) return spawnable;
    }
  }

  // Last resort: the user's login shell. IDE/daemon processes can run with a
  // minimal PATH, so CLIs installed via nvm/fnm/mise/asdf or custom prefixes
  // only become visible once the login rc files are sourced.
  const fromShell = whichViaLoginShell(binaryName, undefined, env);
  if (fromShell) {
    const spawnable = resolveWindowsSpawnableBin(fromShell);
    if (!isDeadCmdShim(spawnable)) return spawnable;
  }

  return binaryName;
}

/**
 * Prepend extra bin dirs to PATH when missing (IDE PATH is often sparse).
 * binDirs is priority-ordered (see versionManagerBinDirs: "newest versions
 * first"), so prepend it as a block to keep that order intact. Per-dir
 * unshift would reverse it, letting the oldest nvm version's `node` shadow
 * newer ones when a `#!/usr/bin/env node` npm shim is spawned.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} binDirs
 */
export function enrichPathWithBinDirs(env, binDirs = []) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = env[pathKey] || env.PATH || '';
  const parts = current ? current.split(sep) : [];
  const extra = [];
  for (const dir of binDirs) {
    if (dir && !parts.includes(dir) && !extra.includes(dir)) {
      extra.push(dir);
    }
  }
  env[pathKey] = [...extra, ...parts].join(sep);
  if (pathKey !== 'PATH') {
    env.PATH = env[pathKey];
  }
}

/**
 * Spawn env for a resolved CLI binary. The binary's own dir leads PATH so a
 * `#!/usr/bin/env node` npm shim launches with the node it was installed
 * under — a stale node from an unrelated version-manager dir must not
 * shadow it (pi under Node <22.8 dies with "node:module does not provide an
 * export named 'enableCompileCache'"). Bare names add no dir.
 * @param {string} bin - resolved CLI path
 * @param {string} [home]
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildCliSpawnEnv(bin, home = homedir(), baseEnv = process.env) {
  const env = { ...baseEnv };
  const dirs = commonCliBinDirs(home);
  const normalized = stripOuterQuotes(bin);
  if (isAbsolute(normalized)) {
    dirs.unshift(dirname(normalized));
  }
  enrichPathWithBinDirs(env, dirs);
  return env;
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
 *
 * @param {string} [home]
 * @param {NodeJS.ProcessEnv} [env] - source of APPDATA/LOCALAPPDATA/ProgramFiles
 */
export function commonCliBinDirs(home = homedir(), env = process.env) {
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
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    dirs.push(join(appData, 'npm'));
    // OMP Windows native installer (e.g. C:\Users\<user>\AppData\Local\omp).
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    dirs.push(join(localAppData, 'omp'));
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    dirs.push(join(programFiles, 'nodejs'));
    const programFilesX86 = env['ProgramFiles(x86)'];
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
