/**
 * Shared headless CLI spawn + stream loop for Grok / Kimi / OpenCode.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { emitSendError, endStream } from './marker-protocol.js';
import { resolveCliSpawn } from './cli-path.js';

/**
 * taskkill argument vector for killing a whole Windows process tree
 * (/T = tree, /F = force) — the same call the Java manual-cancel path makes
 * (PlatformUtils.terminateProcess). Exported pure so the argument contract
 * is unit-testable on every platform (this codebase has no platform-faking
 * precedent — see cli-path.test.js, which extracts win32 spawn logic into
 * pure helpers for the same reason); the win32 branch that spawns it is
 * inspection-verified. Returns null when the pid cannot be trusted so the
 * caller falls back to the direct handle kill.
 * @param {number|undefined} pid
 * @returns {string[]|null}
 */
export function win32TreeKillArgs(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return ['/PID', String(pid), '/T', '/F'];
}

/**
 * How long a POSIX process group gets to honor SIGTERM before the escalation
 * to SIGKILL — long enough for a clean CLI shutdown, short enough that a
 * tree ignoring the graceful signal does not outlive the kill.
 */
const POSIX_KILL_ESCALATION_MS = 5000;

/**
 * A child Node has already reaped (exit code or signal recorded on the
 * handle) must never receive a follow-up signal.
 */
function isChildProcessDone(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * POSIX half of killChildTree, extracted with injectable kill/timer seams so
 * the SIGTERM→SIGKILL escalation is unit-testable on every platform (same
 * pattern as win32TreeKillArgs). Sends SIGTERM to the process group —
 * falling back to the direct handle kill when the group is already gone —
 * then, unless the child has been reaped within the window, escalates to
 * SIGKILL the same way. The timer is unref'd so a pending escalation never
 * keeps the event loop (or process exit) waiting.
 * @param {import('child_process').ChildProcess} child
 * @param {object} [options]
 * @param {number} [options.escalateAfterMs] SIGTERM → SIGKILL window
 * @param {(pid: number, signal: NodeJS.Signals) => void} [options.killFn]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimeoutFn]
 * @param {(timer: unknown) => void} [options.clearTimeoutFn]
 * @returns {() => void} disarmer cancelling a still-pending escalation
 */
export function posixTreeKillEscalate(child, {
  escalateAfterMs = POSIX_KILL_ESCALATION_MS,
  killFn = (pid, signal) => process.kill(pid, signal),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const killGroup = (signal) => {
    try {
      killFn(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  killGroup('SIGTERM');
  const timer = setTimeoutFn(() => {
    if (isChildProcessDone(child)) return;
    killGroup('SIGKILL');
  }, escalateAfterMs);
  // A pending escalation must not delay process exit.
  timer?.unref?.();
  return () => clearTimeoutFn(timer);
}

/**
 * Kill a spawned CLI and its whole process tree. Non-Windows children run in
 * their own process group (detached), so a negative-pid SIGTERM reaches the
 * CLI's own grandchildren too — with a short-window escalation to SIGKILL so
 * a tree that ignores the graceful signal still dies (see
 * posixTreeKillEscalate). On Windows the direct handle kill would leave
 * those grandchildren alive (story 1.10 AC4 gap — only the auto-reap goes
 * through here; Java's manual cancel already uses taskkill /T), so this
 * mirrors Java: `taskkill /PID <pid> /T /F`, fire-and-forget (unref'd so a
 * reap during shutdown never delays exit), falling back to the direct kill
 * when taskkill cannot run or reports failure. Exported for callers that own
 * an extra termination path on the same child (e.g. the gemini
 * silence-window reap) so every killer shares one semantics.
 */
export function killChildTree(child, label) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      const args = win32TreeKillArgs(child.pid);
      if (!args) {
        child.kill();
        return;
      }
      const fallbackDirectKill = () => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      };
      try {
        const killer = spawn('taskkill', args, { stdio: 'ignore' });
        // A non-zero taskkill exit is most often "already gone" — the direct
        // fallback is harmless there (kill on a dead handle is a no-op).
        killer.on('error', fallbackDirectKill);
        killer.on('close', (code) => {
          if (code !== 0) fallbackDirectKill();
        });
        killer.unref?.();
      } catch {
        fallbackDirectKill();
      }
    } else {
      // Graceful first, forced second: a tree that ignores SIGTERM (or is
      // stuck inside it) is reaped by the escalation instead of surviving.
      posixTreeKillEscalate(child);
    }
  } catch (error) {
    console.error(`[WARN][${label}] Failed to kill child:`, error?.message || error);
  }
}

/**
 * Spawn a CLI, stream stdout lines, map stderr for diagnostics.
 *
 * @param {object} options
 * @param {string} options.bin
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} options.label - log / error label
 * @param {(line: string) => void} options.onLine
 * @param {(line: string) => boolean} [options.shouldTerminate] - when set and it
 *   returns true for a parsed stdout line, the child tree is killed and the
 *   stream is finished as a success (for CLIs that keep running after emitting
 *   a final result line, e.g. `mcode exec` exec.result).
 * @param {() => void} [options.onCloseBeforeEnd] - called before endStream once
 * @param {(message: string) => void} [options.onError] - when set, called instead of
 *   writing `[SEND_ERROR]` (used by session-less ask paths: prompt enhance / commit)
 * @param {boolean} [options.emitEndStream=true] - when false, skip chat stream end markers
 * @param {(child: import('child_process').ChildProcess) => void} [options.onSpawn] - called
 *   once right after a successful spawn, with the child handle. Callers that need to act
 *   on the live process (watchdogs) get their only access to it here.
 * @returns {Promise<{ code: number|null, signal: NodeJS.Signals|null, hadError: boolean, errorMessage?: string }>}
 */
export function runCliStreaming({
  bin,
  args,
  cwd,
  env = process.env,
  label,
  onLine,
  shouldTerminate,
  onCloseBeforeEnd,
  onError,
  emitEndStream = true,
  onSpawn,
}) {
  return new Promise((resolve) => {
    let hadError = false;
    let lastErrorMessage = '';
    let streamEnded = false;
    let intentionallyTerminated = false;

    const reportError = (message) => {
      lastErrorMessage = String(message || `Unknown ${label} error`);
      if (typeof onError === 'function') {
        try {
          onError(lastErrorMessage);
        } catch (error) {
          console.error(`[WARN][${label}] onError failed:`, error?.message || error);
        }
        return;
      }
      emitSendError(lastErrorMessage, label);
    };

    const finish = (payload) => {
      if (streamEnded) return;
      streamEnded = true;
      try {
        onCloseBeforeEnd?.();
      } catch (error) {
        console.error(`[WARN][${label}] onCloseBeforeEnd failed:`, error?.message || error);
      }
      if (emitEndStream !== false) {
        endStream();
      }
      resolve({
        ...payload,
        ...(lastErrorMessage ? { errorMessage: lastErrorMessage } : {}),
      });
    };

    let child;
    try {
      const invocation = resolveCliSpawn(bin, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      child = spawn(invocation.file, invocation.args, invocation.options);
    } catch (error) {
      hadError = true;
      reportError(`Failed to spawn ${label} CLI (${bin}): ${error?.message || error}`);
      finish({ code: null, signal: null, hadError });
      return;
    }

    if (typeof onSpawn === 'function') {
      try {
        onSpawn(child);
      } catch (error) {
        console.error(`[WARN][${label}] onSpawn failed:`, error?.message || error);
      }
    }

    const onParentSignal = () => killChildTree(child, label);
    process.once('SIGTERM', onParentSignal);
    process.once('SIGINT', onParentSignal);
    process.once('SIGHUP', onParentSignal);

    const stdoutRl = createInterface({ input: child.stdout });
    // Rolling tail only — never accumulate the child's full stderr.
    let stderrTail = '';

    stdoutRl.on('line', (line) => {
      try {
        onLine(line);
      } catch (error) {
        console.error(`[WARN][${label}] onLine failed:`, error?.message || error);
      }
      if (!intentionallyTerminated && typeof shouldTerminate === 'function') {
        let terminate = false;
        try {
          terminate = shouldTerminate(line) === true;
        } catch (error) {
          console.error(`[WARN][${label}] shouldTerminate failed:`, error?.message || error);
        }
        if (terminate) {
          intentionallyTerminated = true;
          killChildTree(child, label);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      hadError = true;
      const hint = error?.code === 'ENOENT'
        ? `${label} CLI not found. Install it and ensure \`${bin}\` is on PATH.`
        : (error?.message || String(error));
      reportError(hint);
    });

    child.on('close', (code, signal) => {
      process.off('SIGTERM', onParentSignal);
      process.off('SIGINT', onParentSignal);
      process.off('SIGHUP', onParentSignal);

      if (!hadError
        && !intentionallyTerminated
        && code !== 0
        && signal !== 'SIGTERM'
        && signal !== 'SIGINT') {
        const tail = stderrTail.trim().slice(-800);
        reportError(
          `${label} CLI exited with code ${code}${signal ? ` (signal ${signal})` : ''}`
          + (tail ? `\n${tail}` : '')
        );
        hadError = true;
      }

      finish({ code, signal, hadError });
    });
  });
}
