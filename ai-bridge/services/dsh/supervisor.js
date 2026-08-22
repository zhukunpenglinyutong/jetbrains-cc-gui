/**
 * DSH host supervisor (ported from desktop-cc-gui engine/dsh/supervisor.rs).
 *
 * Probe authority is `host.describe`. Ownership is `spawned` or `adopted`.
 * One-shot bridge processes cannot hold the host child, so a spawned host is
 * detached and recorded in a state file — later bridge invocations (and other
 * IDE windows) adopt it through the same probe path, and the settings panel
 * can stop it via the recorded pid.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, openSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  commonCliBinDirs,
  enrichPathWithBinDirs,
  resolveCliPath,
  resolveCliSpawn,
  resolveWindowsSpawnableBin,
} from '../../utils/cli-path.js';
import {
  buildPresetOverlay,
  getHeadlessBaseIds,
  isKnownDshPresetId,
  readDshPresetFile,
  resolveDshPresetDir,
} from './preset-overlay.js';
import { DshHostClient, DshTransportError, originFromHostPort, probeDescribe } from './host.js';

const SPAWN_READY_TIMEOUT_MS = process.platform === 'win32' ? 45_000 : 20_000;
const SPAWN_POLL_MS = 250;
const VERSION_PROBE_TIMEOUT_MS = 5_000;

function logDebug(...args) {
  console.error('[DEBUG][DSH]', ...args);
}

export function runtimeSettingsFromEnv(env = process.env) {
  const host = (env.DSH_HOST || '').trim() || '127.0.0.1';
  const port = Number(env.DSH_PORT) > 0 ? Number(env.DSH_PORT) : 3080;
  const autoStart = (env.DSH_AUTO_START || '').trim().toLowerCase() !== 'false';
  const binPath = (env.DSH_BIN || '').trim() || null;
  const dshPreset = (env.DSH_PRESET || '').trim();
  return { binPath, host, port, autoStart, dshPreset };
}

function stateFilePath() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, '.codemoss', 'dsh-host.json');
}

function readStateFile() {
  try {
    const raw = readFileSync(stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // missing / malformed state is fine
  }
  return null;
}

function writeStateFile(state) {
  try {
    const file = stateFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    // state persistence is best-effort
  }
}

function removeStateFile() {
  try {
    rmSync(stateFilePath(), { force: true });
  } catch {
    // ignore
  }
}

function normalizeDshPreset(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function presetNeedsReload(remembered, requestedPreset) {
  const requested = normalizeDshPreset(requestedPreset);
  // State files written by older bridge versions have no preset field. They
  // are known to be the default only when the caller also requests default.
  if (!remembered || typeof remembered.preset !== 'string') {
    return requested !== '';
  }
  return normalizeDshPreset(remembered.preset) !== requested;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort command line for a pid ('' when unavailable). */
function processCommandLine(pid) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true }
      );
      return (result.stdout || '').trim();
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    return (result.stdout || '').trim();
  } catch {
    return '';
  }
}

/**
 * A dsh-looking executable token: `dsh`, `dsh.cmd`, `dsh.exe`, `dsh.js`, …
 * Anchored to a path/whitespace boundary so `notes-dsh.txt` or `adsh` (PID
 * reuse) never match.
 */
const DSH_BIN_TOKEN = /(^|[\s/\\"'])dsh([.\-_]\w+)*\b/;

/**
 * Whether a command line looks like our `dsh web` host. A bare substring
 * match on "dsh" is too loose (PID reuse could hand us an unrelated process
 * whose cmdline happens to contain "dsh"), so require the recorded bin path /
 * basename, or at least a dsh-looking executable token.
 */
export function looksLikeDshHostCommand(commandLine, bin) {
  if (!commandLine) {
    return false;
  }
  if (typeof bin === 'string' && bin) {
    if (commandLine.includes(bin)) {
      return true;
    }
    // argv may show a shim/basename rather than the recorded absolute path.
    const base = bin.split(/[\\/]/).pop() || '';
    if (base && base !== 'dsh' && commandLine.includes(base)) {
      return true;
    }
  }
  return DSH_BIN_TOKEN.test(commandLine);
}

/**
 * Guard against PID reuse: the recorded pid may now belong to an unrelated
 * process. Only treat it as our host when the command line mentions the dsh
 * binary (spawned as `dsh web …` or `node …/dsh …`).
 */
function isDshHostProcess(pid, bin) {
  return looksLikeDshHostCommand(processCommandLine(pid), bin);
}

/**
 * Candidate install locations for the `dsh` binary. Hermes (the DSH-native
 * installer) keeps it under ~/.hermes/node/bin; npm global and the common
 * CLI dirs cover the rest.
 */
function dshHomeBinDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const dirs = [
    join(home, '.hermes', 'node', 'bin'),
    join(home, '.dsh', 'bin'),
    join(home, '.local', 'bin'),
  ];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      dirs.push(join(appData, 'npm'));
      dirs.push(join(appData, 'hermes', 'node', 'bin'));
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      dirs.push(join(localAppData, 'Programs', 'hermes', 'node', 'bin'));
    }
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      dirs.push(join(userProfile, 'scoop', 'shims'));
    }
  }
  return dirs;
}

export function resolveDshBin(customBin) {
  if (customBin && customBin.trim()) {
    const resolved = process.platform === 'win32'
      ? resolveWindowsSpawnableBin(customBin.trim(), (p) => existsSync(p))
      : customBin.trim();
    if (resolved && existsSync(resolved)) {
      return resolved;
    }
  }
  return resolveCliPath({
    binaryName: 'dsh',
    envKeys: ['DSH_BIN', 'DSH_PATH', 'DSH_CLI_PATH'],
    homeCandidates: [
      '{home}/.hermes/node/bin/{bin}',
      '{home}/.dsh/bin/{bin}',
      '{home}/.local/bin/{bin}',
      '{home}/scoop/shims/{bin}',
    ],
  });
}

export function probeDshVersion(bin) {
  try {
    const invocation = resolveCliSpawn(bin, ['--version'], {
      windowsHide: true,
    });
    const result = spawnSync(invocation.file, invocation.args, {
      ...invocation.options,
      encoding: 'utf8',
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    const match = text.match(/(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?)/);
    if (match) {
      return match[1];
    }
  } catch {
    // unknown version
  }
  return 'unknown';
}

/**
 * Remove stale `dsh-preset-*.patch` overlays from the state dir. A patch file
 * is only read by the host at boot, and spawnDshWeb runs after the previous
 * spawned host was stopped — so any leftover patch belongs to a dead host and
 * would otherwise pile up on every preset switch.
 */
function cleanupStalePresetPatches(stateDir) {
  try {
    for (const entry of readdirSync(stateDir)) {
      if (/^dsh-preset-.+\.patch$/.test(entry)) {
        rmSync(join(stateDir, entry), { force: true });
      }
    }
  } catch {
    // best-effort cleanup
  }
}

function spawnDshWeb(bin, host, port, preset = '') {
  const args = ['web', '--host', host, '--port', String(port)];
  // One stable log next to the state file, truncated per spawn — avoids
  // accumulating dsh-web-spawn-*.log files in tmpdir.
  const logFile = join(dirname(stateFilePath()), 'dsh-web.log');
  let logFd;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    logFd = openSync(logFile, 'w');
  } catch {
    logFd = 'ignore';
  }
  // The dsh bin is a node script (`#!/usr/bin/env node`); Hermes bundles node
  // next to it, so make sure the spawn PATH can resolve both.
  const env = { ...process.env };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  enrichPathWithBinDirs(env, [...dshHomeBinDirs(), ...commonCliBinDirs(home)]);
  if (preset && isKnownDshPresetId(preset)) {
    try {
      const baseIds = getHeadlessBaseIds({ bin, args: [], shell: false });
      const presetText = readDshPresetFile(preset, { bin, args: [], shell: false });
      const presetDir = resolveDshPresetDir(preset, { bin, args: [], shell: false });
      const overlay = presetText && baseIds
        ? buildPresetOverlay({ presetId: preset, presetText, baseIds, presetDir: presetDir || '' })
        : null;
      if (overlay) {
        const stateDir = dirname(stateFilePath());
        cleanupStalePresetPatches(stateDir);
        const patchFile = join(stateDir, `dsh-preset-${Date.now()}.patch`);
        writeFileSync(patchFile, overlay, 'utf8');
        args.push('--patch', patchFile);
        logDebug(`preset=${preset} overlay=${overlay.length} chars`);
      } else {
        console.error(`[DEBUG][DSH] preset=${preset} skipped: composition unavailable`);
      }
    } catch (error) {
      console.error(`[DEBUG][DSH] preset=${preset} failed: ${error?.message || error}`);
    }
  }
  const invocation = resolveCliSpawn(bin, args, {
    detached: true,
    stdio: ['ignore', logFd === 'ignore' ? 'ignore' : logFd, logFd === 'ignore' ? 'ignore' : logFd],
    windowsHide: true,
    env,
  });
  const child = spawn(invocation.file, invocation.args, invocation.options);
  child.unref();
  return { child, logFile };
}

async function waitForDescribe(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await probeDescribe(origin, 2_000);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS));
    }
  }
  throw lastError || new DshTransportError(`dsh host did not become ready at ${origin}`);
}

/**
 * Read-only attach: adopt a running host, never spawn.
 */
export async function connectExisting(settings) {
  const origin = originFromHostPort(settings.host, settings.port);
  const describe = await probeDescribe(origin);
  return {
    origin,
    host: settings.host,
    port: settings.port,
    ownership: 'adopted',
    describe,
    client: new DshHostClient(origin),
  };
}

/**
 * Probe → adopt; otherwise spawn one detached `dsh web` and wait for ready.
 * A previously spawned (state-file recorded) live host is adopted, which also
 * covers a second IDE window racing the first one's spawn.
 */
export async function ensureHost(settings) {
  const origin = originFromHostPort(settings.host, settings.port);
  const remembered = readStateFile();
  let existing = null;
  let reloaded = false;
  try {
    existing = await connectExisting(settings);
  } catch {
    // Host not up yet — fall through.
  }

  if (existing) {
    const requestedPreset = normalizeDshPreset(settings.dshPreset);
    // The host counts as ours only when the state file recorded it, the pid
    // is still alive, and the process still looks like dsh (PID-reuse guard).
    const ownedRunning = remembered
      && remembered.origin === origin
      && isPidAlive(remembered.pid)
      && isDshHostProcess(remembered.pid, remembered.bin);
    if (!ownedRunning || !presetNeedsReload(remembered, requestedPreset)) {
      // A preset only takes effect on hosts this bridge spawns (it is applied
      // via --patch at boot). An adopted/external host keeps whatever
      // composition it was started with — warn instead of silently ignoring
      // the user's selection.
      const presetApplied = ownedRunning
        && typeof remembered.preset === 'string'
        && normalizeDshPreset(remembered.preset) === requestedPreset;
      if (requestedPreset !== '' && !presetApplied) {
        console.error(
          `[DSH] Agent preset "${requestedPreset}" requested, but the DSH host at ${origin} `
          + 'was not spawned by this plugin and cannot be reloaded — the preset will NOT '
          + 'be applied. Stop the external `dsh web` process and let the plugin '
          + 'auto-start the host.'
        );
      }
      return existing;
    }

    logDebug(
      `reloading spawned host for preset change: ${normalizeDshPreset(remembered.preset) || 'default'} -> `
      + `${requestedPreset || 'default'}`
    );
    const stopped = await stopSpawnedHost(settings);
    if (!stopped.success) {
      throw new DshTransportError(`Failed to reload DSH host: ${stopped.error || 'stop failed'}`);
    }
    reloaded = stopped.stopped;
    // The host was ours and is now stopped; fall through to spawn it with the
    // requested preset. If it disappeared concurrently, the same path is safe.
  }

  const refreshedRemembered = readStateFile();
  if (refreshedRemembered && refreshedRemembered.origin === origin && isPidAlive(refreshedRemembered.pid)) {
    try {
      const describe = await waitForDescribe(origin, SPAWN_READY_TIMEOUT_MS);
      return {
        origin,
        host: settings.host,
        port: settings.port,
        ownership: 'spawned',
        describe,
        client: new DshHostClient(origin),
      };
    } catch {
      // recorded spawn never became healthy — respawn below
    }
  }

  if (!settings.autoStart && !reloaded) {
    throw new DshTransportError(
      `DSH host is not running at ${origin}. Start \`dsh web\` or enable auto-start.`
    );
  }

  const bin = resolveDshBin(settings.binPath);
  const { child, logFile } = spawnDshWeb(
    bin,
    settings.host,
    settings.port,
    settings.dshPreset || '',
  );
  writeStateFile({
    pid: child.pid,
    origin,
    host: settings.host,
    port: settings.port,
    bin,
    logFile,
    preset: normalizeDshPreset(settings.dshPreset),
    startedAt: new Date().toISOString(),
  });

  try {
    const describe = await waitForDescribe(origin, SPAWN_READY_TIMEOUT_MS);
    return {
      origin,
      host: settings.host,
      port: settings.port,
      ownership: 'spawned',
      describe,
      client: new DshHostClient(origin),
    };
  } catch (error) {
    let logTail = '';
    try {
      const content = readFileSync(logFile, 'utf8');
      logTail = content.slice(-1024).trim();
    } catch {
      // no log
    }
    throw new DshTransportError(
      `Failed to start DSH host at ${origin}: ${error.message}${logTail ? `\n${logTail}` : ''}`
    );
  }
}

/**
 * Status probe for the settings panel. Never spawns.
 */
export function getDshStatus(settings) {
  const bin = resolveDshBin(settings.binPath);
  const binExists = bin.includes('/') || bin.includes('\\') ? existsSync(bin) : true;
  const probed = binExists ? probeDshVersion(bin) : null;
  const origin = originFromHostPort(settings.host, settings.port);
  const remembered = readStateFile();
  // version stays null when the probe yields nothing parseable, so the UI
  // never renders a meaningless "vunknown" badge.
  return {
    bin,
    installed: binExists,
    version: probed && probed !== 'unknown' ? probed : null,
    origin,
    remembered,
  };
}

export async function collectDshStatus(settings) {
  const base = getDshStatus(settings);
  const result = {
    success: true,
    provider: 'dsh',
    installed: base.installed,
    version: base.version,
    bin: base.bin,
    origin: base.origin,
    hostRunning: false,
    ownership: null,
    describe: null,
  };
  try {
    const describe = await probeDescribe(base.origin);
    result.hostRunning = true;
    result.describe = describe;
    result.ownership =
      base.remembered && base.remembered.origin === base.origin && isPidAlive(base.remembered.pid)
        ? 'spawned'
        : 'adopted';
  } catch {
    // host down — leave hostRunning false
  }
  return result;
}

/**
 * Stop a host this bridge spawned (state-file recorded). Adopted hosts are
 * never killed, and a recorded pid whose process no longer looks like dsh
 * (PID reuse) is never killed either. Returns a small status object for the
 * settings UI.
 */
export async function stopSpawnedHost(settings) {
  const origin = originFromHostPort(settings.host, settings.port);
  const remembered = readStateFile();
  if (!remembered || remembered.origin !== origin || !isPidAlive(remembered.pid)) {
    removeStateFile();
    return { success: true, stopped: false, reason: 'no-spawned-host' };
  }
  if (!isDshHostProcess(remembered.pid, remembered.bin)) {
    // PID reuse — the recorded pid now belongs to an unrelated process.
    removeStateFile();
    return { success: true, stopped: false, reason: 'pid-reused' };
  }
  try {
    process.kill(remembered.pid, 'SIGTERM');
  } catch (error) {
    return { success: false, stopped: false, error: error.message };
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isPidAlive(remembered.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isPidAlive(remembered.pid)) {
    try {
      process.kill(remembered.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  removeStateFile();
  return { success: true, stopped: true };
}
