/**
 * Codex CLI resolver.
 *
 * Locates the installed `codex` CLI like the other headless providers.
 * External installations win; the old dependency directory is a read-only
 * compatibility fallback, never an install/update/uninstall target.
 *
 * Official npm layout (see bin/codex.js of @openai/codex):
 *  - platform package: @openai/codex-<platform>-<arch> holds
 *    vendor/<target-triple>/codex/codex[.exe]
 *  - historical layouts: vendor/<triple>/bin/codex.exe and
 *    vendor/<triple>/codex[.exe]
 *  - fallback: the main package's own vendor/<target-triple> tree
 *  - companion launcher: <main package>/bin/codex.js (node script)
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { listCliCandidates, resolveCliPath, stripOuterQuotes } from '../../utils/cli-path.js';

export const CODEX_CLI_ENV_KEYS = ['CODEX_BIN', 'CODEX_PATH', 'CODEX_CLI_PATH'];

/** Home install locations of the official CLI / npm global prefix. */
const CODEX_HOME_CANDIDATES = [
  '{home}/.local/bin/{bin}', '{home}/.cargo/bin/{bin}',
  '{home}/.codex/bin/{bin}',
];

/** Uses the same PATH, home and login-shell discovery as OpenCode. */
export function discoverCodexCli() {
  const path = resolveCliPath({ binaryName: 'codex', homeCandidates: CODEX_HOME_CANDIDATES });
  return path === 'codex' ? null : path;
}

/**
 * Every candidate `codex` executable in resolution order, without probing any
 * of them. A machine commonly has several installs (version managers, npm
 * prefixes, a manual download) and only some of them are complete.
 *
 * @returns {string[]}
 */
export function discoverCodexCliCandidates() {
  return listCliCandidates({
    binaryName: 'codex',
    envKeys: CODEX_CLI_ENV_KEYS,
    homeCandidates: CODEX_HOME_CANDIDATES,
  });
}

function isCliFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

const TARGET_TRIPLES = {
  'linux:x64': 'x86_64-unknown-linux-musl',
  'linux:arm64': 'aarch64-unknown-linux-musl',
  'android:x64': 'x86_64-unknown-linux-musl',
  'android:arm64': 'aarch64-unknown-linux-musl',
  'darwin:x64': 'x86_64-apple-darwin',
  'darwin:arm64': 'aarch64-apple-darwin',
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
};

const PLATFORM_PACKAGE_PREFIX = {
  linux: 'linux',
  android: 'linux',
  darwin: 'darwin',
  win32: 'win32',
};

const ARCH_SUFFIX = { x64: 'x64', arm64: 'arm64' };

function binaryName(platform) {
  return platform === 'win32' ? 'codex.exe' : 'codex';
}

export function targetTripleFor(platform, arch) {
  return TARGET_TRIPLES[`${platform}:${arch}`] || null;
}

/**
 * Candidate relative layouts of the native binary inside a vendor root.
 * Ordered newest-first; the historical `bin/` layout stays last.
 */
export function vendorBinaryCandidates(vendorRoot, triple, platform) {
  const name = binaryName(platform);
  return [
    join(vendorRoot, triple, 'codex', name),
    join(vendorRoot, triple, name),
    join(vendorRoot, triple, 'bin', name),
  ];
}

function platformPackageName(platform, arch) {
  const plat = PLATFORM_PACKAGE_PREFIX[platform];
  const arc = ARCH_SUFFIX[arch];
  if (!plat || !arc) {
    return null;
  }
  return `@openai/codex-${plat}-${arc}`;
}

function findNativeBinary(codexPackageDir, triple, platform, arch) {
  const platformPackage = platformPackageName(platform, arch);
  if (!platformPackage) {
    return null;
  }
  // Platform packages appear in two places depending on the install:
  // nested under the main package (optionalDependencies of @openai/codex),
  // or hoisted into the node_modules root that holds the @openai scope.
  const nodeModulesRoot = dirname(dirname(codexPackageDir));
  const scanRoots = [join(codexPackageDir, 'node_modules'), nodeModulesRoot];
  for (const scanRoot of scanRoots) {
    const platformDir = join(scanRoot, platformPackage);
    for (const candidate of vendorBinaryCandidates(
      join(platformDir, 'vendor'), triple, platform)) {
      if (isCliFile(candidate)) {
        return candidate;
      }
    }
  }
  for (const candidate of vendorBinaryCandidates(
    join(codexPackageDir, 'vendor'), triple, platform)) {
    if (isCliFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readPackageVersion(packageDir) {
  const pkg = readPackageJson(packageDir);
  return pkg && typeof pkg.version === 'string' ? pkg.version : null;
}

function readPackageJson(packageDir) {
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The `@openai/codex` package a path belongs to, when that path is the npm
 * launcher (`<package>/bin/codex.js`). Symlinked bin shims (`/usr/local/bin/codex`
 * → `.../bin/codex.js`) resolve through their real target first.
 *
 * @param {string} candidate
 * @returns {string|null} package directory
 */
function nodeLauncherPackageDir(candidate) {
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  if (basename(real) !== 'codex.js' || basename(dirname(real)) !== 'bin') {
    return null;
  }
  const packageDir = dirname(dirname(real));
  const pkg = readPackageJson(packageDir);
  return pkg && pkg.name === '@openai/codex' ? packageDir : null;
}

/**
 * Whether a discovered `codex` path can actually start.
 *
 * Only filesystem facts are used — no child process is spawned, because CLI
 * version probing belongs to the CLI settings page. The one decisive case is
 * the npm launcher: `bin/codex.js` delegates to the platform package's vendored
 * binary and exits 1 (`spawn ... ENOENT`) when that package is missing, which
 * happens with partially synced registries or a half-removed global install.
 *
 * @param {string} candidate
 * @returns {{usable: boolean, kind?: string, command?: string[], reason?: string, suspect?: boolean}}
 */
export function classifyCodexCli(candidate, { platform = process.platform, arch = process.arch } = {}) {
  const path = stripOuterQuotes(candidate);
  if (!isCliFile(path)) {
    return { usable: false, command: [path], reason: `${path} does not exist or is not a file` };
  }
  const launcherPackage = nodeLauncherPackageDir(path);
  if (!launcherPackage) {
    return { usable: true, kind: 'native-binary', command: [path] };
  }
  const triple = targetTripleFor(platform, arch);
  const bundled = triple ? findNativeBinary(launcherPackage, triple, platform, arch) : null;
  if (bundled) {
    return { usable: true, kind: 'native-binary', command: [path] };
  }
  // The launcher's own require-based lookup is not fully modelled here, so an
  // install we cannot confirm is only *suspect*: it is demoted behind every
  // confirmed candidate instead of being dropped (never block a working CLI).
  return {
    usable: false,
    suspect: true,
    // Kept so an explicit override can still be launched as a last resort.
    command: [path],
    reason: `${path} is an @openai/codex npm launcher without a ${triple ?? 'matching'}`
      + ' platform binary (incomplete install)',
  };
}

/**
 * Resolve the managed CLI inside a dependency root.
 * @param {string} depsRoot e.g. <deps>/codex-sdk/node_modules
 * @returns {object|null} {packageDir, kind, command, version} or null
 */
export function resolveManagedCodexCli(
  depsRoot,
  { platform = process.platform, arch = process.arch, nodePath = 'node' } = {}
) {
  const triple = targetTripleFor(platform, arch);
  if (!depsRoot || !triple) {
    return null;
  }
  // New installs place @openai/codex directly under node_modules; legacy
  // @openai/codex-sdk installs hoist it beside the SDK or nest it inside.
  const packageCandidates = [
    join(depsRoot, '@openai', 'codex'),
    join(depsRoot, '@openai', 'codex-sdk', 'node_modules', '@openai', 'codex'),
    join(depsRoot, '@openai', 'codex-sdk'),
  ];
  for (const packageDir of packageCandidates) {
    if (!existsSync(packageDir)) {
      continue;
    }
    const binary = findNativeBinary(packageDir, triple, platform, arch);
    if (binary) {
      return {
        packageDir,
        kind: 'native-binary',
        command: [binary],
        version: readPackageVersion(packageDir),
      };
    }
    const launcher = join(packageDir, 'bin', 'codex.js');
    if (packageDir !== join(depsRoot, '@openai', 'codex-sdk') && isCliFile(launcher)) {
      return {
        packageDir,
        kind: 'node-launcher',
        command: [nodePath, launcher],
        version: readPackageVersion(packageDir),
      };
    }
  }
  return null;
}

/**
 * Resolve the Codex CLI from external installations, then an existing legacy directory.
 *
 * @param {object} opts
 * @param {string|null} [opts.explicitPath] user-configured external CLI path
 * @param {string|null} [opts.depsRoot] <deps>/codex-sdk/node_modules
 * @param {string} [opts.platform] override for tests
 * @param {string} [opts.arch] override for tests
 * @param {string} [opts.nodePath] node executable for the companion launcher
 * @param {object} [opts.env] environment for the CODEX_* path override
 * @param {() => string[]} [opts.discoverCliCandidates] test hook: every external candidate
 * @param {() => string|null} [opts.discoverCli] test hook: a single external candidate
 * @returns {object} resolution result with status resolved|unresolved, the chosen
 *   `command`, the ordered `candidates` still available as startup fallbacks and
 *   the `rejected` candidates with their concrete reason
 */
export function resolveCodexCli({
  explicitPath = null,
  depsRoot = null,
  platform = process.platform,
  arch = process.arch,
  nodePath = 'node',
  env = process.env,
  discoverCli = null,
  discoverCliCandidates = null,
} = {}) {
  const configured = explicitPath
    || CODEX_CLI_ENV_KEYS.map((key) => env[key]).find((value) => value?.trim())
    || null;
  if (configured && configured.trim().length > 0) {
    const trimmed = configured.trim();
    const classified = classifyCodexCli(trimmed, { platform, arch });
    // An explicit override is honoured even when only its completeness is in
    // doubt - the user asked for this binary by name. A path that cannot be a
    // CLI at all stays a hard error.
    if (!classified.usable && !classified.suspect) {
      return {
        status: 'unresolved',
        source: 'explicit',
        reason: `configured Codex CLI is unusable: ${classified.reason}`,
        rejected: [{ path: trimmed, reason: classified.reason }],
      };
    }
    const candidate = { command: classified.command, source: 'explicit', label: trimmed, kind: classified.kind };
    return {
      status: 'resolved',
      source: 'explicit',
      kind: classified.kind,
      command: classified.command,
      version: null,
      candidates: [candidate],
      rejected: classified.suspect ? [{ path: trimmed, reason: classified.reason }] : [],
    };
  }

  const discovered = discoverCliCandidates
    ? discoverCliCandidates()
    : discoverCli ? [discoverCli()].filter(Boolean) : discoverCodexCliCandidates();
  const candidates = [];
  // Installs that only *look* incomplete keep a low-priority slot behind every
  // confirmed candidate: a heuristic must never take away a working CLI.
  const suspects = [];
  const rejected = [];
  for (const path of discovered ?? []) {
    const classified = classifyCodexCli(path, { platform, arch });
    if (classified.usable) {
      candidates.push({ command: classified.command, source: 'external', label: path, kind: classified.kind });
    } else if (classified.suspect) {
      suspects.push({ command: [path], source: 'external', label: path, kind: 'native-binary',
        suspect: true, reason: classified.reason });
    } else {
      rejected.push({ path, reason: classified.reason });
    }
  }

  const managed = resolveManagedCodexCli(depsRoot, { platform, arch, nodePath });
  if (managed) {
    candidates.push({ command: managed.command, source: 'legacy', label: managed.packageDir, kind: managed.kind });
  }
  candidates.push(...suspects);

  if (candidates.length > 0) {
    const [primary] = candidates;
    return {
      status: 'resolved',
      source: primary.source,
      kind: primary.kind,
      command: primary.command,
      version: managed && primary.source === 'legacy' ? managed.version : null,
      candidates,
      rejected,
    };
  }

  const ignored = rejected.length > 0
    ? ` (ignored unusable install: ${rejected.map((entry) => `${entry.path}: ${entry.reason}`).join('; ')})`
    : '';
  return {
    status: 'unresolved',
    source: 'external',
    reason: 'Codex CLI not found; install the official CLI and re-check Settings > Provider Management > CLI'
      + ignored,
    candidates: [],
    rejected,
  };
}
