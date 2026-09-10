/**
 * ZCode app-server JSON-RPC client.
 *
 * Speaks line-delimited JSON (UTF-8, one object per line) over stdio with a
 * `node <zcode.cjs> app-server` child process. Wire notes (CLI 0.16.x):
 *  - envelopes carry NO `jsonrpc` field (the server rejects it with -32600);
 *  - our requests use numeric ids from a local counter;
 *  - server-initiated ("reverse") requests use string ids ("server-N") and
 *    MUST be answered — an unanswered reverse request hangs its caller;
 *  - notifications have a method and no id;
 *  - stderr must be drained continuously: the server logs stack traces there,
 *    and a full pipe buffer blocks the whole node process (symptom: every
 *    request times out while the process looks alive).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class ZcodeAppServerClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.nodePath  node executable
   * @param {string} opts.cliPath   path to zcode.cjs
   * @param {string} [opts.cwd]     child working directory
   * @param {object} [opts.env]     full environment for the child
   * @param {(method: string, params: object) => Promise<object>} [opts.onReverseRequest]
   *        async handler for server-initiated requests; throw {code,message}
   *        to reply with a JSON-RPC error.
   */
  constructor({ nodePath, cliPath, cwd, env, onReverseRequest } = {}) {
    super();
    this.nodePath = nodePath || 'node';
    this.cliPath = cliPath;
    this.cwd = cwd;
    this.env = env;
    this.onReverseRequest = onReverseRequest || null;

    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.exited = false;
    this.exitError = null;
  }

  get alive() {
    return !!this.child && !this.exited && this.child.exitCode === null;
  }

  start() {
    if (this.alive) return;
    if (!this.cliPath) {
      throw new Error('ZCode CLI path not resolved (zcode.cjs not found)');
    }

    this.exited = false;
    this.exitError = null;
    this.child = spawn(this.nodePath, [this.cliPath, 'app-server'], {
      cwd: this.cwd,
      env: this.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group on POSIX so close() can reap the whole tree
      // (the server forks helper children that otherwise linger).
      detached: process.platform !== 'win32',
    });

    this.child.on('error', (err) => this.#handleExit(err));
    this.child.on('exit', (code, signal) => {
      this.#handleExit(new Error(`zcode app-server exited (code=${code}, signal=${signal})`));
    });

    const outRl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    outRl.on('line', (line) => this.#handleLine(line));

    // stderr: drain unconditionally; surface lines for diagnostics and API
    // error detection (429/quota surface here before any RPC error does).
    const errRl = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    errRl.on('line', (line) => this.emit('stderrLine', line));

    this.child.stdin.on('error', () => {
      // EPIPE when the child died mid-write; the exit handler rejects pendings.
    });
  }

  /**
   * Send a request and await its result.
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`zcode request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.#write({ id, method, params });
    });
  }

  #write(obj) {
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n', 'utf8');
    } catch (err) {
      this.#handleExit(err);
    }
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit('protocolError', new Error(`unparseable app-server line: ${trimmed.slice(0, 200)}`));
      return;
    }

    const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result')
      || Object.prototype.hasOwnProperty.call(msg, 'error');

    // Response to one of our requests (numeric id).
    if (typeof msg.id === 'number' && hasResult && !msg.method) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || `zcode error ${msg.error.code}`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Server-initiated request (string id) — must be answered, always async.
    if (typeof msg.id === 'string' && msg.method) {
      this.#answerReverseRequest(msg.id, msg.method, msg.params || {});
      return;
    }

    // Notification (method, no id).
    if (msg.method) {
      this.emit('notification', { method: msg.method, params: msg.params || {} });
    }
  }

  async #answerReverseRequest(id, method, params) {
    let reply;
    try {
      if (!this.onReverseRequest) {
        const err = new Error(`reverse request not supported: ${method}`);
        err.code = -32601;
        throw err;
      }
      const result = await this.onReverseRequest(method, params);
      reply = { id, result: result ?? {} };
    } catch (err) {
      reply = {
        id,
        error: {
          code: typeof err?.code === 'number' ? err.code : -32603,
          message: err?.message || String(err),
        },
      };
    }
    if (this.alive) this.#write(reply);
  }

  #handleExit(err) {
    if (this.exited) return;
    this.exited = true;
    this.exitError = err;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
    this.emit('exit', err);
  }

  /** Kill the app-server and its helpers; reject all pending requests. */
  close() {
    if (!this.child) {
      this.#handleExit(new Error('zcode app-server closed'));
      return;
    }
    const child = this.child;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch { /* already gone */ }
        }, 3000).unref();
      }
    } catch { /* best effort */ }
    this.#handleExit(new Error('zcode app-server closed'));
  }
}
