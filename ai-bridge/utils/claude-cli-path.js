import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { quoteCmdArg, resolveCliSpawn, stripOuterQuotes } from './cli-path.js';
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
 * Two things `cmd.exe /c` does to a command line that `resolveCliSpawn` leaves
 * as they are, both of which would change what the CLI receives:
 * - `%` is doubled by `quoteCmdArg`, and a command line (unlike a batch file)
 *   does not turn `%%` back into `%`, so an argument such as an MCP URL with
 *   `%3D` reached the CLI as `%%3D`. An argument that contains `%` is handed
 *   over through an environment variable instead; cmd expands it once and does
 *   not look at the value again.
 * - A UNC working directory (`\\server\share`, `\\wsl.localhost\...`) is not
 *   supported by cmd, which prints a warning and starts the launcher in the
 *   Windows directory, so the CLI would work in the wrong folder. Mapping the
 *   share with `pushd` is no way out: the CLI then sees a temporary drive letter
 *   and files its sessions under that, so History and resume cannot find them.
 *   Starting is refused with an explanation instead.
 *
 * Returns the invocation unchanged when it does not go through cmd.exe.
 *
 * @param {{ file: string, args: string[], options: object }} invocation - from resolveCliSpawn
 * @param {{ command?: string, args: string[], cwd?: string }} request - the SDK's original launcher, arguments and cwd
 * @throws {Error} when the launcher would run through cmd.exe in a UNC working directory
 */
export function adaptCmdInvocation(invocation, { command, args = [], cwd } = {}) {
  const viaCmd = invocation.options?.windowsVerbatimArguments === true
    && invocation.args.length === 4
    && invocation.args[0] === '/d'
    && invocation.args[1] === '/s'
    && invocation.args[2] === '/c';
  if (!viaCmd) return invocation;

  let line = invocation.args[3];
  let env = invocation.options.env;
  const withPercent = [...new Set(args.filter((arg) => typeof arg === 'string' && arg.includes('%')))];
  if (withPercent.length > 0) {
    env = { ...env };
    withPercent.forEach((arg, index) => {
      const name = `CLAUDE_GUI_ARG_${index}`;
      env[name] = arg.replace(/"/g, '""');
      line = line.split(quoteCmdArg(arg)).join(`"%${name}%"`);
    });
  }

  if (typeof cwd === 'string' && cwd.startsWith('\\\\')) {
    throw new Error(
      `The Claude CLI path override ${command ? `"${stripOuterQuotes(command)}" ` : ''}is a .cmd/.bat file, `
      + `and cmd.exe cannot run in the network folder "${cwd}": the CLI would start in the Windows directory instead. `
      + 'Use an .exe or a .js/.mjs launcher for this project, or open the project from a local drive.',
    );
  }

  return {
    ...invocation,
    args: ['/d', '/s', '/c', line],
    options: { ...invocation.options, env },
  };
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
    const invocation = adaptCmdInvocation(
      resolveCliSpawn(
        command,
        args,
        { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        forceWindows,
      ),
      { command, args, cwd },
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
 * @param {typeof spawn} [options.spawnFn] - test hook
 */
export function claudeCliSdkOptions(override, { stderr, forceWindows, spawnFn } = {}) {
  if (!override) return {};
  return {
    pathToClaudeCodeExecutable: override,
    ...(isWindowsBatchLauncher(override, forceWindows)
      ? { spawnClaudeCodeProcess: createBatchLauncherSpawner({ stderr, forceWindows, spawnFn }) }
      : {}),
  };
}
