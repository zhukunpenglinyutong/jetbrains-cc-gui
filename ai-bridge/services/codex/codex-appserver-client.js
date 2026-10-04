import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { getCodemossDir } from '../../utils/path-utils.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const CODEX_TARGETS = {
  'win32-x64': ['x86_64-pc-windows-msvc', 'codex.exe'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 'codex.exe'],
  'darwin-x64': ['x86_64-apple-darwin', 'codex'],
  'darwin-arm64': ['aarch64-apple-darwin', 'codex'],
  'linux-x64': ['x86_64-unknown-linux-musl', 'codex'],
  'linux-arm64': ['aarch64-unknown-linux-musl', 'codex'],
};

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function getBundledCodexPath() {
  const target = CODEX_TARGETS[platformKey()];
  if (!target) return null;
  return join(
    getCodemossDir(),
    'dependencies',
    'codex-sdk',
    'node_modules',
    '@openai',
    `codex-${process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'x64' ? 'x64' : 'arm64'}`,
    'vendor',
    target[0],
    'bin',
    target[1],
  );
}

/**
 * Resolve the native Codex executable used by the installed TypeScript SDK.
 * The SDK keeps this path private, so the app-server transport resolves the
 * same optional platform package without depending on SDK internals.
 */
export function resolveCodexExecutablePath(env = process.env) {
  const configuredPath = env.CODEX_CLI_PATH || env.CODEX_PATH;
  if (configuredPath && existsSync(configuredPath)) return configuredPath;

  const bundledPath = getBundledCodexPath();
  if (bundledPath && existsSync(bundledPath)) return bundledPath;

  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function buildAppServerArgs(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return ['app-server', '--stdio'];
  }
  const tomlValue = JSON.stringify(baseUrl.trim());
  return ['app-server', '--stdio', '--config', `openai_base_url=${tomlValue}`];
}

function isResponse(message) {
  return Object.prototype.hasOwnProperty.call(message, 'result')
    || Object.prototype.hasOwnProperty.call(message, 'error');
}

export class CodexAppServerClient {
  constructor({
    cwd,
    env,
    baseUrl,
    apiKey,
    executablePath,
    onReverseRequest,
    spawnProcess = spawn,
  } = {}) {
    this.cwd = cwd;
    this.env = { ...(env || process.env) };
    if (apiKey) this.env.CODEX_API_KEY = apiKey;
    if (!this.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
      this.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'codex_sdk_ts';
    }
    this.baseUrl = baseUrl;
    this.executablePath = executablePath || resolveCodexExecutablePath(this.env);
    this.onReverseRequest = onReverseRequest || null;
    this.spawnProcess = spawnProcess;

    this.child = null;
    this.exited = false;
    this.exitError = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = [];
  }

  get alive() {
    return !!this.child && !this.exited && this.child.exitCode === null;
  }

  start() {
    if (this.alive) return;

    this.exited = false;
    this.exitError = null;
    this.child = this.spawnProcess(this.executablePath, buildAppServerArgs(this.baseUrl), {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    this.child.once('error', (error) => this.#handleExit(error));
    this.child.once('exit', (code, signal) => {
      this.#handleExit(new Error(`Codex app-server exited (code=${code}, signal=${signal})`));
    });

    const stdout = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    stdout.on('line', (line) => this.#handleLine(line));

    const stderr = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    stderr.on('line', (line) => console.error(`[CODEX_APP_SERVER] ${line}`));
    this.child.stdin.on('error', () => {});
  }

  request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.start();
    this.#write({ method, params });
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'cc-gui', version: '0.5.9' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
    return result;
  }

  async startThread(params) {
    return this.request('thread/start', params);
  }

  async resumeThread(params) {
    return this.request('thread/resume', params);
  }

  async startTurn(params) {
    return this.request('turn/start', params);
  }

  async steerTurn(threadId, turnId, input) {
    return this.request('turn/steer', { threadId, expectedTurnId: turnId, input });
  }

  async nextNotification(timeoutMs = 0) {
    if (this.notifications.length > 0) return this.notifications.shift();
    if (this.exited) throw this.exitError || new Error('Codex app-server exited');
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.notificationWaiters.indexOf(waiter);
          if (index >= 0) this.notificationWaiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
      }
      this.notificationWaiters.push(waiter);
    });
  }

  async *streamTurn(threadId, input, extraParams = {}) {
    const response = await this.startTurn({ threadId, input, ...extraParams });
    const turnId = response?.turn?.id || null;
    this.activeTurnId = turnId;

    while (true) {
      const notification = await this.nextNotification(500);
      if (!notification) {
        yield { method: 'ccgui/sessionPoll', params: { threadId, turnId } };
        continue;
      }
      const params = notification.params || {};
      if ((params.threadId && params.threadId !== threadId)
          || (turnId && params.turnId && params.turnId !== turnId)) {
        continue;
      }
      const finished = notification.method === 'turn/completed' || notification.method === 'turn/failed';
      if (finished) {
        this.activeTurnId = null;
      }
      yield notification;
      if (finished) return;
    }
  }

  #write(message) {
    if (!this.alive || !this.child?.stdin?.writable) {
      throw this.exitError || new Error('Codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      console.error(`[CODEX_APP_SERVER] Ignoring invalid JSON line: ${trimmed.slice(0, 200)}`);
      return;
    }

    if (message.id !== undefined && !message.method && isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `Codex app-server error ${message.error.code}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      console.info(`[CODEX_APP_SERVER] Reverse request received: ${message.method}`);
      this.#answerReverseRequest(message.id, message.method, message.params || {});
      return;
    }

    if (message.method) {
      const notification = { method: message.method, params: message.params || {} };
      if (['turn/completed', 'turn/failed'].includes(message.method)
          && (message.params?.turn?.id || message.params?.turnId) === this.activeTurnId) {
        this.activeTurnId = null;
      }
      const waiter = this.notificationWaiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(notification);
      } else {
        this.notifications.push(notification);
      }
    }
  }

  async #answerReverseRequest(id, method, params) {
    try {
      if (!this.onReverseRequest) {
        const error = new Error(`Codex reverse request is not supported: ${method}`);
        error.code = -32601;
        throw error;
      }
      const result = await this.onReverseRequest(method, params);
      if (this.alive) this.#write({ id, result: result ?? {} });
    } catch (error) {
      console.error(`[CODEX_APP_SERVER] Reverse request failed (${method}): ${error?.message || String(error)}`);
      if (this.alive) {
        this.#write({
          id,
          error: {
            code: typeof error?.code === 'number' ? error.code : -32603,
            message: error?.message || String(error),
          },
        });
      }
    }
  }

  #handleExit(error) {
    if (this.exited) return;
    this.exited = true;
    this.exitError = error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const waiter of this.notificationWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  close() {
    if (!this.child || this.exited) return;
    const child = this.child;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    } catch {
      // Best effort cleanup; the exit handler rejects outstanding requests.
    }
    this.#handleExit(new Error('Codex app-server closed'));
  }
}
