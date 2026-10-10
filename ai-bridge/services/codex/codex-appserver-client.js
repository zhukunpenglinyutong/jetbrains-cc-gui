/**
 * Codex app-server stdio client (protocol layer only).
 *
 * Spawns the app-server transport (`<cli> app-server --listen stdio://`),
 * performs the initialize/initialized handshake once, and exchanges NDJSON
 * envelopes over stdin/stdout. Wire contract (design D2, matching the
 * generated types under docs/codex/app-server-protocol/generated):
 *
 *  - client request:   {id, method, params}          (no `jsonrpc` field)
 *  - response:         {id, result} | {id, error}
 *  - notification:     {method, params}
 *  - server request:   {id, method, params}          (numeric OR string id)
 *
 * Envelopes are dispatched by STRUCTURE, not by id type: the same numeric id
 * can be in flight in both directions at once, so responses to our requests
 * and server-initiated requests use separate registries and never alias.
 *
 * Error classification (design D3 contract surface):
 *  - err.code = 'RPC_TIMEOUT' with err.phase 'notWritten' | 'writtenUnconfirmed'
 *    — a timeout is a client-side wait failure, never proof the native
 *    operation ended. A late response still arrives through 'lateResponse'.
 *  - 'WRITE_FAILED' (EPIPE / stdin error), 'CHILD_EXITED', 'CLOSED'
 *  - initialize failures surface as 'INIT_FAILED'/'INIT_TIMEOUT'; business
 *    requests never go on the wire before the handshake succeeds.
 *
 * The client never decides approvals or falls back to exec: unknown server
 * requests are answered 'unsupported' (-32601) unless a handler is installed.
 */

import { spawn } from 'node:child_process';
import { buildCliSpawnEnv, resolveCliSpawn } from '../../utils/cli-path.js';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { redactCodexDiagnostic } from './codex-diagnostics.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_EXIT_DRAIN_TIMEOUT_MS = 5_000;

/** Truncated/sanitized stderr lines kept to explain a startup death. */
export const DEFAULT_STDERR_TAIL_LINES = 5;

export const CLIENT_STATES = Object.freeze([
  'idle',
  'starting',
  'initializing',
  'ready',
  'closing',
  'exited',
]);

export class CodexAppServerClient extends EventEmitter {
  #readerCleanup = null;
  #shutdownTimer = null;
  #drainTimer = null;
  // Bounded, sanitized tail of the child's stderr. The CLI reports its own
  // startup failures there (e.g. a broken launcher printing `spawn … ENOENT`),
  // and without it a startup death is only an exit code.
  #stderrTail = [];
  /**
   * @param {object} opts
   * @param {string[]} opts.command  argv prefix for the transport, e.g.
   *        ['codex.exe'] or ['node', 'codex.js']; 'app-server --listen
   *        stdio://' is appended here.
   * @param {string} [opts.cwd] child working directory
   * @param {object} [opts.env] full child environment
   * @param {string[]} [opts.sensitiveEnvNames] native provider credential names for diagnostic redaction
   * @param {{name: string, title: string|null, version: string}} [opts.clientInfo]
   * @param {number} [opts.requestTimeoutMs] default short-RPC budget
   * @param {number} [opts.stderrTailLines] sanitized stderr lines retained for diagnostics
   * @param {(method: string, params: object, ctx: {id: any}) => Promise<object>} [opts.onServerRequest]
   *        non-blocking reverse-request handler. The promise may settle much
   *        later (e.g. waiting on UI); the reader loop never awaits it.
   */
  constructor({
    command,
    cwd = null,
    env = undefined,
    sensitiveEnvNames = [],
    clientInfo = null,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    exitDrainTimeoutMs = DEFAULT_EXIT_DRAIN_TIMEOUT_MS,
    stderrTailLines = DEFAULT_STDERR_TAIL_LINES,
    onServerRequest = null,
    spawnFn = null,
  } = {}) {
    super();
    if (!Array.isArray(command) || command.length === 0) {
      throw new Error('CodexAppServerClient requires a command argv prefix');
    }
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.sensitiveEnvNames = new Set(sensitiveEnvNames.map(name => process.platform === 'win32' ? name.toUpperCase() : name));
    this.clientInfo = clientInfo
      || { name: 'codemoss_intellij', title: 'CC GUI', version: '0.0.0' };
    this.requestTimeoutMs = requestTimeoutMs;
    // Grace period for stdio to drain after the child's exit event; if a
    // grandchild inherited the pipes, 'close' never fires without teardown.
    this.exitDrainTimeoutMs = exitDrainTimeoutMs;
    this.stderrTailLines = Math.max(0, Math.trunc(Number(stderrTailLines) || 0));
    this.onServerRequest = onServerRequest;
    // Test-only injection: spawnFn(argv) returns a child-like object with
    // {stdin, stdout, stderr, pid, on, kill}. Production never sets this.
    this.spawnFn = spawnFn;

    this.state = 'idle';
    this.child = null;
    this.nextRequestId = 1;
    // Direction-scoped registries: ids never alias across directions.
    this.pendingRequests = new Map();   // our numeric ids -> entry
    this.serverRequests = new Map();    // server request ids -> {method, params}
    this.initializePromise = null;
    this.exitError = null;
    this.processExited = false;
    this.exitSettled = false;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.closeRequested = false;
    this.childStdinBuffer = null;
    this.#readerCleanup = null;
  }

  get alive() {
    return !this.processExited && (this.state === 'ready'
      || this.state === 'initializing'
      || this.state === 'starting');
  }

  /** Wait for process exit and drained stdio, including a close already in progress. */
  waitForExit() {
    return this.exitPromise;
  }

  /**
   * Sanitized stderr tail captured so far (oldest first). Exposed for the
   * runtime layer, which folds it into the user-visible failure message.
   *
   * @returns {string[]}
   */
  stderrTail() {
    return [...this.#stderrTail];
  }

  #setState(next) {
    if (this.state !== next) {
      this.state = next;
      this.emit('stateChanged', next);
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Spawn the transport and begin the initialize handshake (single flight). */
  start() {
    if (this.state !== 'idle') {
      return this.ensureInitialized();
    }
    this.#setState('starting');
    const argv = [...this.command, 'app-server', '--listen', 'stdio://'];
    const launch = resolveCliSpawn(this.command[0], argv.slice(1), {
      cwd: this.cwd || undefined,
      env: buildCliSpawnEnv(this.command[0], undefined, this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = this.spawnFn
      ? this.spawnFn(argv)
      : spawn(launch.file, launch.args, launch.options);

    this.child.on('error', (err) => {
      const message = this.sanitizeDiagnostic(err?.message ?? 'unknown process error');
      if (!(this.child?.pid > 0)) {
        this.#finalizeExit(this.#startupFailure(
          new ClassifiedError('CHILD_EXITED', `codex app-server spawn failed: ${message}`)
        ));
        return;
      }
      // A failed termination is not proof that the writer has exited.
      const failure = new ClassifiedError('PROCESS_ERROR', `codex app-server process error: ${message}`);
      this.#failAllPending(failure);
      this.emit('processError', failure);
      this.close();
    });
    this.child.on('exit', (code, signal) => {
      // Exit forbids further writes, but buffered final items still own their
      // turn. Node's close event confirms that those pipes have drained.
      this.processExited = true;
      // A death before READY is a startup failure: nothing was dispatched, so
      // the runtime layer may retry with another resolved CLI.
      const exitedBeforeReady = this.state !== 'ready';
      this.exitError = this.#exitError(code, signal, exitedBeforeReady);
      // A grandchild that inherited our stdout/stderr pipes (e.g. a dev server
      // the agent launched with `&`) keeps them open after the child died, so
      // 'close' never arrives and waitForExit() would hang reset/shutdown
      // forever. Allow a short drain grace, then tear the pipes down ourselves.
      if (this.#drainTimer == null && !this.exitSettled) {
        this.#drainTimer = setTimeout(() => {
          this.#drainTimer = null;
          if (this.exitSettled) return;
          try { this.child?.stdout?.destroy(); } catch { /* best effort */ }
          try { this.child?.stderr?.destroy(); } catch { /* best effort */ }
          try { this.child?.stdin?.destroy(); } catch { /* best effort */ }
          this.#finalizeExit(this.exitError || new ClassifiedError(
            'CHILD_EXITED', 'codex app-server exited (stdio drain timed out)'
          ));
        }, this.exitDrainTimeoutMs);
        // Deliberately NOT unref'd: the timer must fire even when it is the only
        // pending handle, e.g. during daemon shutdown awaiting waitForExit().
      }
    });
    this.child.on('close', (code, signal) => {
      this.#finalizeExit(this.exitError || new ClassifiedError(
        'CHILD_EXITED', `codex app-server exited (code=${code}, signal=${signal})`
      ));
    });

    const stdoutRl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    const stderrRl = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    // stderr is drained continuously and independently: the CLI logs stack
    // traces there, and a full pipe buffer would block the whole process.
    stderrRl.on('line', (line) => {
      const clean = this.sanitizeDiagnostic(line);
      this.#rememberStderr(clean);
      this.emit('stderrLine', clean);
    });
    stdoutRl.on('line', (line) => this.#handleLine(line));

    this.child.stdin.on('error', (err) => {
      // A broken pipe also strands turns that already received their ack.
      const failure = new ClassifiedError('WRITE_FAILED',
        `stdin write failed: ${this.sanitizeDiagnostic(err?.message)}`);
      this.#failAllPending(failure);
      this.emit('stdinError', failure);
      this.close();
    });

    this.#readerCleanup = () => {
      stdoutRl.close();
      stderrRl.close();
    };

    this.#setState('initializing');
    return this.#beginInitialize();
  }

  /**
   * Single-flight initialize: spawn → initialize response → initialized
   * notification → READY. Concurrent callers share one promise.
   */
  ensureInitialized() {
    if (this.initializePromise) {
      return this.initializePromise;
    }
    if (this.state === 'ready') {
      return Promise.resolve();
    }
    if (this.state === 'idle') {
      this.start();
      return this.initializePromise;
    }
    // exited/closing without an active promise (spawn error path) — surface it.
    return Promise.reject(this.exitError || new ClassifiedError('INIT_FAILED', 'client is not running'));
  }

  #beginInitialize() {
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#failPending('__initialize__', new ClassifiedError('INIT_TIMEOUT', 'codex app-server initialize timed out'));
        this.close();
      }, this.requestTimeoutMs);
      this.pendingRequests.set('__initialize__', {
        method: 'initialize',
        timer,
        writeState: 'notWritten',
        resolve: (result) => {
          clearTimeout(timer);
          // Send the initialized notification only after the response arrived.
          try {
            this.#writeLine({ method: 'initialized', params: {} });
          } catch (err) {
            rejectPromise(err);
            return;
          }
          this.#setState('ready');
          resolvePromise();
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        },
      });
    });
    this.initializePromise = promise;
    promise.catch(() => {
      // Keep the rejection observable for late awaiters without crashing.
    });
    try {
      this.#writeRequest('initialize', {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      }, '__initialize__');
    } catch (err) {
      this.#failPending('__initialize__', err);
    }
    return promise;
  }

  // ==========================================================================
  // Requests and notifications
  // ==========================================================================

  /**
   * Business RPC. Awaits the shared initialize handshake first; when the
   * handshake fails, no business RPC is written.
   *
   * @param {string} method
   * @param {object} [params]
   * @param {object} [opts] {timeoutMs}
   * @returns {Promise<object>} resolves with the response result
   */
  request(method, params = {}, { timeoutMs, onDispatch } = {}) {
    const budget = timeoutMs ?? this.requestTimeoutMs;
    return this.ensureInitialized().then(() => new Promise((resolvePromise, rejectPromise) => {
      const id = this.nextRequestId++;
      onDispatch?.(id);
      const timer = setTimeout(() => {
        const entry = this.pendingRequests.get(id);
        if (!entry) {
          return;
        }
        this.pendingRequests.delete(id);
        const phase = entry.writeState === 'notWritten' ? 'notWritten' : 'writtenUnconfirmed';
        rejectPromise(new ClassifiedError(
          'RPC_TIMEOUT',
          `codex app-server request timed out after ${budget}ms: ${method}`,
          { phase, method, id }
        ));
      }, budget);
      this.pendingRequests.set(id, {
        method,
        timer,
        writeState: 'notWritten',
        resolve: resolvePromise,
        reject: rejectPromise,
      });
      try {
        this.#writeRequest(method, params, id);
      } catch (err) {
        this.#failPending(id, err);
      }
    }));
  }

  /** Fire-and-forget notification. */
  notify(method, params = {}) {
    this.#writeLine({ method, params });
  }

  /**
   * Send a typed result for a server request. The original id is echoed
   * unchanged (number or string).
   */
  replyServerRequest(id, result) {
    this.#writeLine({ id, result: result ?? {} });
    this.serverRequests.delete(id);
  }

  /** Send a typed error for a server request. */
  replyServerError(id, code, message) {
    this.#writeLine({ id, error: { code: typeof code === 'number' ? code : -32603, message: message || 'codex client error' } });
    this.serverRequests.delete(id);
  }

  #writeRequest(method, params, id) {
    const entry = this.pendingRequests.get(id);
    this.#writeLine({ id, method, params }, () => {
      // Flush confirmed: the OS pipe accepted the full frame. The server may
      // still not have processed it, so this never upgrades to a native fact.
      if (entry && this.pendingRequests.get(id) === entry) {
        entry.writeState = 'written';
      }
    });
    if (entry) {
      // write() returned with the frame queued — conservative state until the
      // flush callback confirms delivery.
      entry.writeState = 'writtenUnconfirmed';
    }
  }

  #writeLine(obj, onFlush) {
    if (this.processExited) {
      throw this.exitError || new ClassifiedError('CHILD_EXITED', 'codex app-server exited');
    }
    if (this.state === 'closing') {
      throw new ClassifiedError('CLOSED', 'codex app-server client is closed');
    }
    if (this.state === 'exited') {
      // Surface the real failure cause, not a synthetic "closed".
      throw this.exitError || new ClassifiedError('CLOSED', 'codex app-server client is closed');
    }
    if (!this.child) {
      throw new ClassifiedError('CHILD_EXITED', 'codex app-server process is not running');
    }
    try {
      const ok = this.child.stdin.write(JSON.stringify(obj) + '\n', 'utf8', onFlush);
      if (!ok) {
        // Buffer full: bytes are queued but not yet accepted by the OS pipe.
        // The state stays 'writtenUnconfirmed' — conservative by design.
        this.emit('stdinBackpressure');
      }
    } catch (err) {
      const failure = new ClassifiedError('WRITE_FAILED',
        `stdin write failed: ${this.sanitizeDiagnostic(err?.message)}`);
      this.emit('stdinError', failure);
      this.close();
      throw failure;
    }
  }

  // ==========================================================================
  // Wire dispatch (by structure, never by id type)
  // ==========================================================================

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // A stray non-JSON line (e.g. a CLI warning on stdout) must not tear
      // down a live runtime: line-delimited framing resyncs at the next
      // newline, so the malformed line is reported and dropped (D2).
      this.emit('protocolError', new ClassifiedError('PROTOCOL_ERROR',
        `unparseable app-server line: ${this.sanitizeDiagnostic(trimmed.slice(0, 200))}`));
      return;
    }
    if (!msg || typeof msg !== 'object') {
      this.emit('protocolError', new Error(`non-object app-server frame: ${this.sanitizeDiagnostic(trimmed.slice(0, 120))}`));
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    const hasMethod = typeof msg.method === 'string';
    const hasPayload = Object.prototype.hasOwnProperty.call(msg, 'result')
      || Object.prototype.hasOwnProperty.call(msg, 'error');

    if (hasMethod && hasId) {
      this.#dispatchServerRequest(msg);
      return;
    }
    if (hasId && hasPayload && !hasMethod) {
      this.#dispatchResponse(msg);
      return;
    }
    if (hasMethod && !hasId) {
      if (msg.method === 'serverRequest/resolved') {
        this.serverRequests.delete(msg.params?.requestId ?? msg.params?.rpcId);
      }
      this.emit('notification', { method: msg.method, params: msg.params ?? {} });
      return;
    }
    this.emit('protocolError', new Error(`unroutable app-server frame: ${this.sanitizeDiagnostic(trimmed.slice(0, 120))}`));
  }

  #dispatchResponse(msg) {
    // Responses to our initialize request use the sentinel id '__initialize__'.
    if (msg.id === '__initialize__') {
      const entry = this.pendingRequests.get('__initialize__');
      this.pendingRequests.delete('__initialize__');
      if (!entry) {
        return;
      }
      if (msg.error) {
        entry.reject(new ClassifiedError(
          'INIT_FAILED',
          this.sanitizeDiagnostic(msg.error.message || `codex app-server initialize error ${msg.error.code}`)
        ));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.id !== 'number' && typeof msg.id !== 'string') {
      return;
    }
    const entry = this.pendingRequests.get(msg.id);
    if (!entry) {
      // Late response after timeout/cleanup: surfaced so the service can keep
      // its dispatch-phase correlation (D3) without resurrecting the promise.
      this.emit('lateResponse', {
        id: msg.id,
        payload: msg.error ? { error: msg.error } : { result: msg.result },
      });
      return;
    }
    this.pendingRequests.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new ClassifiedError(
        'RPC_ERROR',
        this.sanitizeDiagnostic(msg.error.message || `codex app-server error ${msg.error.code}`),
        { rpcCode: msg.error.code, data: msg.error.data, method: entry.method, id: msg.id }
      ));
    } else {
      entry.resolve(msg.result);
    }
  }

  /** Uses only existing launch credentials to scrub diagnostics; question answers are never cached. */
  sanitizeDiagnostic(value) {
    const secrets = Object.entries(this.env ?? {}).filter(([name]) => /API_KEY|TOKEN|SECRET|AUTHORIZATION|PROVIDER_HEADER/i.test(name)
      || this.sensitiveEnvNames.has(process.platform === 'win32' ? name.toUpperCase() : name))
      .map(([, secret]) => secret);
    return redactCodexDiagnostic(value, secrets);
  }

  #dispatchServerRequest(msg) {
    // Preserve the id exactly as received (number or string).
    const request = { method: msg.method, params: msg.params ?? {} };
    this.serverRequests.set(msg.id, request);
    // An async preview can outlive native cancellation and reuse of the same
    // id. Only the request instance that started it still owns its reply.
    const isPending = () => this.serverRequests.get(msg.id) === request;
    let handedOff = false;
    const release = () => { if (!handedOff && isPending()) this.serverRequests.delete(msg.id); };
    if (!this.onServerRequest) {
      this.replyServerError(msg.id, -32601, `unsupported server request: ${msg.method}`);
      release();
      return;
    }
    // Non-blocking: the handler's promise is never awaited by the reader.
    Promise.resolve()
      .then(() => isPending() ? this.onServerRequest(msg.method, msg.params ?? {}, { id: msg.id, isPending }) : undefined)
      .then((result) => {
        if (!this.alive || !isPending()) return;
        if (result === undefined) {
          // The handler took ownership of the reply (e.g. long UI wait).
          handedOff = true;
          return;
        }
        this.replyServerRequest(msg.id, result);
      })
      .catch((err) => {
        if (!this.alive || !isPending()) return;
        try {
          this.replyServerError(msg.id, err?.code ?? -32603, err?.message || 'reverse request handler failed');
        } catch { /* exit already owns pending-request cleanup */ }
      })
      .finally(release);
  }

  // ==========================================================================
  // Failure finalization
  // ==========================================================================

  /** Keeps the newest sanitized stderr lines within the configured budget. */
  #rememberStderr(line) {
    if (this.stderrTailLines === 0) {
      return;
    }
    const text = String(line ?? '').trim();
    if (!text) {
      return;
    }
    this.#stderrTail.push(text);
    while (this.#stderrTail.length > this.stderrTailLines) {
      this.#stderrTail.shift();
    }
  }

  /** Canonical exit error; `beforeReady` attaches startup diagnostics out of band. */
  #exitError(code, signal, beforeReady) {
    const error = new ClassifiedError(
      'CHILD_EXITED',
      `codex app-server exited (code=${code}, signal=${signal})`
    );
    return beforeReady ? this.#startupFailure(error) : error;
  }

  /**
   * Marks a transport failure that happened before READY and attaches the
   * launch command plus the sanitized stderr tail. The message stays canonical
   * (existing consumers match on it); details travel in `err.details`.
   */
  #startupFailure(error) {
    error.startupFailure = true;
    const stderr = this.#stderrTail.join('\n');
    error.details = {
      exitPhase: 'startup',
      command: [...this.command],
      ...(stderr ? { stderr } : {}),
    };
    return error;
  }

  #failPending(id, err) {
    const entry = this.pendingRequests.get(id);
    if (!entry) {
      return;
    }
    this.pendingRequests.delete(id);
    clearTimeout(entry.timer);
    entry.reject(err);
  }

  #failAllPending(err) {
    for (const id of [...this.pendingRequests.keys()]) {
      this.#failPending(id, err);
    }
  }

  #finalizeExit(err) {
    if (this.exitSettled) {
      return;
    }
    this.exitSettled = true;
    this.processExited = true;
    this.exitError = err;
    if (this.#shutdownTimer != null) {
      clearTimeout(this.#shutdownTimer);
      this.#shutdownTimer = null;
    }
    if (this.#drainTimer != null) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
    }
    // Exactly one failure finalization: timers and registries are cleaned up
    // before the exit event so nothing lingers after 'exited'.
    this.#failAllPending(this.exitError || new ClassifiedError('CHILD_EXITED', 'codex app-server exited'));
    this.serverRequests.clear();
    if (this.#readerCleanup) {
      this.#readerCleanup();
      this.#readerCleanup = null;
    }
    this.#setState('exited');
    this.emit('exited', this.exitError);
    this.resolveExit(this.exitError);
  }

  /**
   * Close the client and clean up the process tree. Idempotent.
   *
   * Uses the same lifecycle rules as the ZCode client: taskkill /T /F on
   * Windows, detached process group on POSIX with an escalating SIGTERM →
   * SIGKILL fallback.
   */
  close() {
    if (this.closeRequested) {
      return;
    }
    this.closeRequested = true;
    if (this.exitSettled) return;
    const child = this.child;
    this.#setState('closing');
    this.#failAllPending(new ClassifiedError('CLOSED', 'codex app-server client closed'));
    if (child && child.pid > 0 && !this.processExited) {
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          const killOwnedChild = () => {
            if (this.child === child && !this.processExited && !this.exitSettled) child.kill();
          };
          killer.on('error', killOwnedChild);
          killer.on('exit', (code) => { if (code !== 0) killOwnedChild(); });
        } else {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
          this.#shutdownTimer = setTimeout(() => {
            this.#shutdownTimer = null;
            if (this.child !== child || this.processExited || this.exitSettled) return;
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch { /* already gone */ }
          }, 3000);
          this.#shutdownTimer.unref?.();
        }
      } catch { /* best effort */ }
    }
    // An exited process still owns its unread tail until close. A synthetic
    // peer without an exit event has no OS writer or pipe teardown to await.
    if (!child || (!(child.pid > 0) && !this.processExited)) {
      this.#finalizeExit(new ClassifiedError('CLOSED', 'codex app-server client closed'));
    }
    try {
      this.child?.stdin?.end();
    } catch { /* already gone */ }
  }
}

/** Error with a classification code and optional correlation metadata. */
export class ClassifiedError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'CodexAppServerError';
    this.code = code;
    Object.assign(this, meta);
  }
}
