import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { resolveCliSpawn, stripOuterQuotes } from './cli-path.js';
import { killChildTree } from './cli-spawn.js';

/**
 * Resolves the user-configured Claude Code CLI executable, if any.
 *
 * The Java daemon sets CLAUDE_CODE_PATH when the user has provided a custom
 * path in Settings > Basic. When set, the Claude Agent SDK is told to spawn
 * that binary instead of its bundled CLI via `pathToClaudeCodeExecutable`.
 *
 * Returns null when unset/blank so callers can spread the field conditionally.
 */
export function getClaudeCliPathOverride() {
  const raw = process.env.CLAUDE_CODE_PATH;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * How long the SDK waits for the launcher's stderr to finish after the process
 * exited, so an exit error still carries the launcher's last output.
 */
const STDERR_CLOSE_GRACE_MS = 2000;

/** A Windows `.cmd`/`.bat` launcher cannot be handed to CreateProcess directly. */
export function isWindowsBatchLauncher(
  executable,
  forceWindows = process.platform === 'win32',
) {
  return forceWindows
    && typeof executable === 'string'
    && /\.(cmd|bat)$/i.test(stripOuterQuotes(executable.trim()));
}

/**
 * Build the SDK's `spawnClaudeCodeProcess` for a `.cmd`/`.bat` launcher.
 *
 * The SDK runs anything that is not a `.js`/`.mjs` file with a plain
 * `child_process.spawn`, which Node refuses for batch files since the
 * CVE-2024-27980 fix (`spawn EINVAL`). The launcher goes through `cmd.exe`
 * instead (see `resolveCliSpawn`). Everything the SDK's own spawn does is kept:
 * piped stdio, stderr forwarded to the `stderr` option, an exit event that
 * follows the end of stderr, and the abort signal. The forced kill takes the
 * whole process tree, because killing only `cmd.exe` would leave the CLI it
 * started running.
 *
 * @param {object} [options]
 * @param {(text: string) => void} [options.stderr] - the query's `stderr` option
 * @param {boolean} [options.forceWindows] - test hook
 * @param {typeof spawn} [options.spawnFn] - test hook
 * @param {(child: import('child_process').ChildProcess, label: string) => void} [options.killTree] - test hook
 * @param {number} [options.stderrGraceMs] - test hook
 * @returns {(spawnOptions: { command: string, args: string[], cwd?: string, env: object, signal?: AbortSignal }) => object}
 */
export function createBatchLauncherSpawner({
  stderr,
  forceWindows,
  spawnFn = spawn,
  killTree = killChildTree,
  stderrGraceMs = STDERR_CLOSE_GRACE_MS,
} = {}) {
  const forwardStderr = typeof stderr === 'function'
    ? stderr
    : (text) => {
      const trimmed = text.trim();
      if (trimmed) console.error(`[SDK-STDERR] ${trimmed}`);
    };

  return ({ command, args, cwd, env, signal }) => {
    const invocation = resolveCliSpawn(
      command,
      args,
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      forceWindows,
    );
    const child = spawnFn(invocation.file, invocation.args, invocation.options);
    const events = new EventEmitter();
    let killed = false;

    const decoder = new StringDecoder('utf8');
    child.stderr.on('data', (chunk) => {
      try {
        forwardStderr(decoder.write(chunk));
      } catch (error) {
        console.error('[WARN][claude-cli] stderr handler failed:', error?.message || error);
      }
    });
    child.stderr.on('error', () => { /* a closed pipe is reported by the exit event */ });

    let exited = false;
    let stderrClosed = false;
    let delivered = false;
    let graceTimer;
    const deliverExit = () => {
      if (delivered) return;
      delivered = true;
      clearTimeout(graceTimer);
      events.emit('exit', child.exitCode, child.signalCode);
    };
    child.stderr.once('close', () => {
      stderrClosed = true;
      if (exited) deliverExit();
    });
    child.once('exit', () => {
      exited = true;
      if (stderrClosed) {
        deliverExit();
        return;
      }
      graceTimer = setTimeout(deliverExit, stderrGraceMs);
      graceTimer.unref?.();
    });
    child.on('error', (error) => events.emit('error', error));

    const killTreeOnce = () => {
      if (killed) return true;
      killed = true;
      killTree(child, 'claude-cli');
      return true;
    };
    if (signal) {
      if (signal.aborted) killTreeOnce();
      else signal.addEventListener('abort', killTreeOnce, { once: true });
    }

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() { return killed; },
      get exitCode() { return child.exitCode; },
      get signalCode() { return child.signalCode; },
      kill: killTreeOnce,
      on: events.on.bind(events),
      once: events.once.bind(events),
      off: events.off.bind(events),
    };
  };
}

/**
 * SDK query options for a user-configured Claude executable: spread into the
 * options object. Empty without an override; a Windows `.cmd`/`.bat` launcher
 * additionally gets a spawner that can start it.
 *
 * @param {string|null|undefined} override - from getClaudeCliPathOverride()
 * @param {object} [options]
 * @param {(text: string) => void} [options.stderr] - the query's `stderr` option, if any
 * @param {boolean} [options.forceWindows] - test hook
 */
export function claudeCliSdkOptions(override, { stderr, forceWindows } = {}) {
  if (!override) return {};
  return {
    pathToClaudeCodeExecutable: override,
    ...(isWindowsBatchLauncher(override, forceWindows)
      ? { spawnClaudeCodeProcess: createBatchLauncherSpawner({ stderr, forceWindows }) }
      : {}),
  };
}
