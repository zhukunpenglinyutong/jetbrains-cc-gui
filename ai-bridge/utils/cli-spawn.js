/**
 * Shared headless CLI spawn + stream loop for Grok / Kimi / OpenCode.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { createInterface } from 'readline';
import { emitSendError, endStream } from './marker-protocol.js';
import { resolveCliSpawn, decodeCliOutput, stripOuterQuotes } from './cli-path.js';

function killChildTree(child, label) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      if (child.pid) {
        // Tree-kill via taskkill so grandchild node processes (npm .cmd shims)
        // do not outlive the cmd.exe wrapper and hold stdout open.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          .on('error', () => {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
          });
        return;
      }
      child.kill();
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
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
 * @param {string} [options.stdinData] - when set, piped to the child's stdin
 *   (and stdio[0] becomes 'pipe'). For payloads that cannot ride argv: Windows
 *   cmd.exe command lines truncate at the first newline and cap near 32k chars,
 *   so multi-line/oversized prompts must go through a stdin pipe instead.
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
  stdinData,
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
        stdio: [stdinData != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      child = spawn(invocation.file, invocation.args, invocation.options);
    } catch (error) {
      hadError = true;
      reportError(`Failed to spawn ${label} CLI (${bin}): ${error?.message || error}`);
      finish({ code: null, signal: null, hadError });
      return;
    }

    // Feed piped payloads after the listeners are wired. EPIPE is expected
    // when the CLI exits before draining stdin (e.g. an immediate arg error),
    // so write failures must not take the stream loop down.
    if (stdinData != null && child.stdin) {
      child.stdin.on('error', () => { /* child exited early; close handler reports */ });
      child.stdin.write(stdinData);
      child.stdin.end();
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
      // cmd.exe emits localized messages in the OEM codepage (GBK on Chinese
      // Windows); decode so the surfaced error is readable, not U+FFFD soup.
      const text = decodeCliOutput(chunk);
      stderrTail = (stderrTail + text).slice(-4000);
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      hadError = true;
      const binPath = stripOuterQuotes(bin);
      const hint = error?.code === 'ENOENT'
        ? (existsSync(binPath)
          ? `${label} CLI failed to start (ENOENT) even though \`${binPath}\` exists — a missing working directory (${cwd}) or a broken shim target inside \`${binPath}\` is the likely cause.`
          : `${label} CLI not found. Install it and ensure \`${bin}\` is on PATH.`)
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
