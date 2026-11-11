/**
 * Client for `omp --mode rpc` / `--mode rpc-ui`.
 *
 * The transport is newline-delimited JSON over stdio (omp protocol v1, not
 * JSON-RPC): commands go to stdin, and stdout carries a `ready` frame, one
 * `response` per command id, and unsolicited frames (session events,
 * `extension_ui_request`, `prompt_result`, ...). Closing stdin makes omp drain
 * its queue and exit 0.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { resolveCliSpawn } from '../../utils/cli-path.js';
import { killChildTree } from '../../utils/cli-spawn.js';

const STDERR_TAIL_CHARS = 4000;
const DEFAULT_START_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_GRACE_MS = 5_000;

function exitMessage(label, { code, signal }, stderrTail) {
  const tail = stderrTail.trim().slice(-800);
  return `${label} CLI exited with code ${code}${signal ? ` (signal ${signal})` : ''}${tail ? `\n${tail}` : ''}`;
}

export class OmpRpcClient {
  #bin;
  #args;
  #cwd;
  #env;
  #label;
  #onFrame;
  #child = null;
  #exit = null;
  #exited;
  #resolveExited;
  #ready = null;
  #pending = new Map();
  #nextId = 1;
  #stderrTail = '';
  #failure = null;

  /**
   * @param {object} options
   * @param {string} options.bin
   * @param {string[]} options.args
   * @param {string} options.cwd
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {string} [options.label] log / error label
   * @param {(frame: object) => void} [options.onFrame] every stdout frame that
   *   is neither `ready` nor the response to a pending request
   */
  constructor({ bin, args = [], cwd, env = process.env, label = 'OMP', onFrame }) {
    this.#bin = bin;
    this.#args = args;
    this.#cwd = cwd;
    this.#env = env;
    this.#label = label;
    this.#onFrame = onFrame;
    this.#exited = new Promise((resolve) => {
      this.#resolveExited = resolve;
    });
  }

  /** Resolves `{ code, signal }` once the process is gone (also after a failed spawn). */
  get exited() {
    return this.#exited;
  }

  get stderrTail() {
    return this.#stderrTail;
  }

  /**
   * Spawn omp and wait for its `ready` frame.
   * @returns {Promise<object>} the ready frame
   */
  start({ timeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#ready = null;
        reject(new Error(`${this.#label} CLI did not become ready within ${timeoutMs} ms`));
        this.kill();
      }, timeoutMs);
      this.#ready = {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };

      try {
        const invocation = resolveCliSpawn(this.#bin, this.#args, {
          cwd: this.#cwd,
          env: this.#env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Own process group so killChildTree reaches the tools omp spawned.
          detached: process.platform !== 'win32',
        });
        this.#child = spawn(invocation.file, invocation.args, invocation.options);
      } catch (error) {
        this.#fail(new Error(`Failed to spawn ${this.#label} CLI (${this.#bin}): ${error?.message || error}`));
        this.#settleExit({ code: null, signal: null });
        return;
      }

      const child = this.#child;
      child.on('error', (error) => {
        // ENOENT also covers a working directory that does not exist.
        const failure = new Error(error?.code === 'ENOENT'
          ? `${this.#label} CLI not found. Install it and ensure \`${this.#bin}\` is on PATH.`
          : (error?.message || String(error)));
        if (error?.code) failure.code = error.code;
        this.#fail(failure);
        // Without a pid nothing was spawned, so do not depend on `close` to settle.
        if (child.pid === undefined) this.#settleExit({ code: null, signal: null });
      });
      child.on('close', (code, signal) => {
        const exit = { code, signal };
        this.#fail(new Error(exitMessage(this.#label, exit, this.#stderrTail)));
        this.#settleExit(exit);
      });
      // A dead child surfaces through `close`; an EPIPE here must not crash the bridge.
      child.stdin.on('error', () => {});
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        this.#stderrTail = (this.#stderrTail + text).slice(-STDERR_TAIL_CHARS);
        process.stderr.write(text);
      });
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => this.#handleLine(line));
    });
  }

  /**
   * Send a command and wait for its response.
   * @param {object} command `id` is assigned unless the caller needs to correlate later frames with it
   * @param {{ timeoutMs?: number }} [options] `0` waits until the process exits
   * @returns {Promise<any>} `response.data`
   */
  request(command, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = typeof command.id === 'string' && command.id ? command.id : `req-${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`${this.#label} did not answer "${command.type}" within ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.#pending.set(id, entry);
      this.send({ ...command, id });
    });
  }

  /** Write one frame without tracking a response. Dropped once the process is gone. */
  send(frame) {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /**
   * End the session: close stdin so omp drains and exits, then kill the
   * process tree if it is still alive after `graceMs`. `graceMs: 0` never
   * kills: it waits until omp exits on its own (same convention as
   * `request`'s `timeoutMs: 0`).
   * @returns {Promise<{ code: number|null, signal: NodeJS.Signals|null }>}
   */
  async close({ graceMs = DEFAULT_CLOSE_GRACE_MS } = {}) {
    if (this.#exit) return this.#exit;
    if (!this.#child) return { code: null, signal: null };
    const stdin = this.#child?.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end();
    const timer = graceMs > 0 ? setTimeout(() => this.kill(), graceMs) : null;
    try {
      return await this.#exited;
    } finally {
      clearTimeout(timer);
    }
  }

  kill() {
    if (this.#child && !this.#exit) killChildTree(this.#child, this.#label);
  }

  #handleLine(line) {
    if (!line || !line.trim()) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    if (frame.type === 'ready' && this.#ready) {
      const ready = this.#ready;
      this.#ready = null;
      ready.resolve(frame);
      return;
    }
    if (frame.type === 'response' && typeof frame.id === 'string' && this.#pending.has(frame.id)) {
      const entry = this.#pending.get(frame.id);
      this.#pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.success === false) {
        const error = new Error(String(frame.error || `${this.#label} rejected "${frame.command}"`));
        if (frame.code) error.code = frame.code;
        entry.reject(error);
      } else {
        entry.resolve(frame.data);
      }
      return;
    }
    try {
      this.#onFrame?.(frame);
    } catch (error) {
      console.error(`[WARN][${this.#label}] frame handler failed:`, error?.message || error);
    }
  }

  /** Reject everything still waiting. The first failure is the one later requests report. */
  #fail(error) {
    if (!this.#failure) this.#failure = error;
    if (this.#ready) {
      const ready = this.#ready;
      this.#ready = null;
      ready.reject(this.#failure);
    }
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(this.#failure);
    }
    this.#pending.clear();
  }

  #settleExit(exit) {
    if (this.#exit) return;
    this.#exit = exit;
    this.#resolveExited(exit);
  }
}
