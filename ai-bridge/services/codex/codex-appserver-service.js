/**
 * Persistent Codex app-server service (one instance per chat host).
 *
 * Owns the native runtime state machine, the root/parent/descendant thread
 * registry, operation dispatch phases, the session FIFO, and the settings
 * revision gate (design D1/D3/D4). The protocol transport is a
 * {@link CodexAppServerClient}; this layer never touches process streams.
 *
 * Runtime states (D3):
 *   STOPPED → STARTING → INITIALIZING → READY → DRAINING → STOPPED
 *   any active state → FAILED (protocol/process failure; next user op may restart)
 *
 * Thread states:
 *   UNLOADED → LOADING → IDLE; IDLE → STARTING → RUNNING/AWAITING_INTERACTION;
 *   LOADING/STARTING/RUNNING/AWAITING_INTERACTION/COMPACTING → INTERRUPTING →
 *   IDLE | FAILED; IDLE → STARTING → COMPACTING → IDLE.
 *
 * Operation dispatch phases (D3): notWritten → writtenUnconfirmed →
 * nativeTurnKnown → terminal. A terminal is finalized at most once; RPC acks,
 * local timeouts, single items, and retrying errors never end an operation.
 *
 * Stop semantics: notWritten + no uncertain bootstrap cancels locally with
 * zero RPC; writtenUnconfirmed keeps the cancel intent and interrupts the
 * moment the native turn id is known; the total confirmation budget is 10s
 * from cancelRequested — acks never reset it. When still unconfirmed the
 * child is closed, its exit awaited, and the operation finalized once (failed).
 *
 * Recovery never replays uncertain work: after a disconnect the thread is
 * resumed only — turn/start is never re-sent automatically.
 */

import { EventEmitter } from 'node:events';
import { projectCodexItemMessages } from './codex-item-projection.js';
import { CodexAppServerClient, ClassifiedError } from './codex-appserver-client.js';
import { buildProjectDocFallbackConfig } from './codex-native-runtime-config.js';

export const SERVICE_STATES = Object.freeze([
  'stopped',
  'starting',
  'initializing',
  'ready',
  'draining',
  'failed',
]);

export const DISPATCH_PHASES = Object.freeze([
  'notWritten',
  'writtenUnconfirmed',
  'nativeTurnKnown',
  'terminal',
]);

export const OPERATION_KINDS = Object.freeze(['send', 'compact', 'review']);

/** Total stop confirmation budget from cancelRequested (D3). */
export const STOP_CONFIRMATION_BUDGET_MS = 10_000;

/**
 * Budget for an acked compaction to announce its native turn. Remote
 * compaction captures step context first, which can outlast the 10s stop
 * budget on large sessions, so a silent compaction only counts as wedged
 * after this longer window.
 */
export const COMPACT_ANNOUNCEMENT_BUDGET_MS = 60_000;

const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'interrupted']);

export class CodexAppServerService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => (CodexAppServerClient|Promise<CodexAppServerClient>)} opts.clientFactory creates a fresh
   *        client per runtime generation (tests inject the stdio peer).
   * @param {string} [opts.sessionEpoch] channel/session epoch for event envelopes.
   * @param {string} [opts.channelId]
   * @param {object} [opts.launchOptions] fingerprint-relevant launch inputs
   *        ({authMode, apiKey, baseUrl, codexHome, ...}); see
   *        computeCodexRuntimeFingerprint.
   * @param {string} [opts.runtimeFingerprint] precomputed fingerprint.
   * @param {number} [opts.stopBudgetMs]
   * @param {number} [opts.startupAttempts] bounded runtime-start attempts; >1 lets
   *        the daemon fall back to the next resolved CLI when the chosen binary
   *        dies before READY (nothing was dispatched, so a retry replays nothing).
   * @param {(operation, event) => void} [opts.emitMarker] legacy marker emitter
   *        captured per operation (D4: background events must not impersonate
   *        the active request).
   */
  constructor({
    clientFactory,
    sessionEpoch = '1',
    channelId = 'codex',
    launchOptions = {},
    runtimeFingerprint = null,
    emitMarker = null,
    privacyIndex = null,
    stopBudgetMs = STOP_CONFIRMATION_BUDGET_MS,
    compactAnnouncementBudgetMs = COMPACT_ANNOUNCEMENT_BUDGET_MS,
    startupAttempts = 1,
  } = {}) {
    super();
    // clientFactory may also be assigned right after construction (the daemon
    // layer resolves the CLI first); validated at ensureRuntime time.
    this.clientFactory = typeof clientFactory === 'function' ? clientFactory : null;
    this.sessionEpoch = String(sessionEpoch);
    this.channelId = channelId;
    this.launchOptions = launchOptions;
    this.runtimeFingerprint = runtimeFingerprint;
    this.emitMarker = emitMarker;
    this.privacyIndex = privacyIndex;
    // One attempt per resolved CLI candidate. Attempt 1 is the normal path;
    // extra attempts only exist when the daemon found alternatives.
    this.startupAttempts = Math.max(1, Math.trunc(Number(startupAttempts) || 1));
    // True while ensureRuntime owns the start; transport events are deferred to
    // the startup loop so a failed candidate can fall back instead of failing.
    this.startupInFlight = false;
    // Per-candidate startup failures of the current ensureRuntime() call, used
    // to explain which CLI was tried and why it refused to start.
    this.startupFailures = [];

    this.state = 'stopped';
    this.runtimeGeneration = 0;
    this.client = null;
    this.runtimeResetPromise = null;
    this.rootThreadId = null;
    this.desiredThreadId = null;

    // threadId → {threadId, parentThreadId, rootThreadId, state, relationVerified}
    this.threads = new Map();
    this.threadResumes = new Map();
    // Native plan items are independent from turn/plan/updated TODO snapshots.
    // Keeping the item identity here lets a later authoritative item replace a
    // streamed preview instead of appending a second plan card.
    this.planItems = new Map();
    // File-change approvals refer to an item id instead of carrying the patch
    // in the reverse request. Keep the latest native item so the UI can show
    // the exact proposed changes without reading the workspace itself.
    this.itemSnapshots = new Map();
    // clientOperationId → operation
    this.operations = new Map();
    // Native reverse requests remain pending until a typed result is sent.
    // Keeping the method beside the opaque RPC id allows response validation
    // without trusting a browser supplied method name.
    this.pendingInteractions = new Map();
    // Session FIFO: at most one active send/compact/review operation.
    this.queue = [];
    this.activeOperationId = null;
    this.busy = false;

    // Settings revision gate (D8/D3): desired revision frozen per dispatch.
    this.settingsRevision = 0;
    this.desiredSettings = null;
    this.effectiveSettings = null;
    this.pendingSettingsApplication = null;

    // Launch-config rebuild (2.4/4.6): a fingerprint change rebuilds the child
    // at the next idle boundary, then cold-resumes the root thread.
    this.pendingRebuild = false;

    // Total stop/settings confirmation budget (D3). Production keeps the
    // 10s contract; tests may shorten it for deterministic coverage.
    this.stopBudgetMs = stopBudgetMs;
    this.compactAnnouncementBudgetMs = compactAnnouncementBudgetMs;

    // Bootstrap bookkeeping: resume/start in flight whose outcome is unknown.
    this.bootstrapInFlight = false;
    this.failureSettled = false;
    this.stopTimers = [];
    this.completedTurns = new Set();
    this.threadTokenTotals = new Map();
  }

  // ==========================================================================
  // Runtime lifecycle
  // ==========================================================================

  #setState(next) {
    if (this.state !== next) {
      this.state = next;
      this.emit('runtimeStateChanged', { state: next, runtimeGeneration: this.runtimeGeneration,
        runtimePid: this.client?.child?.pid > 0 ? this.client.child.pid : null });
    }
  }

  /** Lazily start the runtime and perform the handshake. Idempotent. */
  async ensureRuntime() {
    if (this.state === 'ready' && this.client?.alive) {
      return;
    }
    if (this.state === 'starting' || this.state === 'initializing') {
      // Another caller is already bringing the runtime up; wait for READY.
      await this.#waitForState('ready');
      return;
    }
    if (this.state === 'draining') {
      await this.#waitForState('stopped');
      return this.ensureRuntime();
    }
    if ((this.client?.closeRequested || this.client?.processExited) && !this.client.exitSettled) {
      await this.client.waitForExit();
      // Read-only callers can share this wait. Re-enter the state gate so
      // exactly one of them owns the next initialize handshake.
      return this.ensureRuntime();
    }
    this.failureSettled = false;
    if (typeof this.clientFactory !== 'function') {
      throw new ClassifiedError('CONFIG', 'CodexAppServerService requires a clientFactory');
    }
    const attempts = Math.max(1, this.startupAttempts);
    this.startupFailures = [];
    // Transport events observed while this flag is set are owned by the loop
    // below, which either falls back to the next CLI or finalizes the failure.
    this.startupInFlight = true;
    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        this.runtimeGeneration += 1;
        const generation = this.runtimeGeneration;
        this.#setState('starting');
        try {
          if (this.privacyIndex?.load) await this.privacyIndex.load();
          const candidate = await this.clientFactory();
          if (this.runtimeGeneration !== generation || this.state !== 'starting') {
            candidate.close();
            throw new ClassifiedError('RUNTIME_RESET', 'Codex runtime was released during client preparation');
          }
          this.client = candidate;
          this.#attachClientHandlers(this.client);
          this.#setState('initializing');
          await this.client.ensureInitialized();
          const configuration = await this.client.request('config/read', {
            includeLayers: false, cwd: this.desiredSettings?.cwd ?? this.launchOptions?.cwd ?? undefined,
          });
          const fallbackNames = configuration?.config?.project_doc_fallback_filenames;
          this.launchOptions = { ...this.launchOptions, nativeConfig: buildProjectDocFallbackConfig({
            ...this.launchOptions?.nativeConfig,
            project_doc_fallback_filenames: Array.isArray(fallbackNames) ? fallbackNames : [],
          }, this.launchOptions?.nativeConfig?.project_doc_fallback_filenames) };
          this.#setState('ready');
          this.bootstrapInFlight = false;
          // Startup diagnostics belong to this attempt chain only: a later
          // mid-turn crash must not be explained by a CLI that already recovered.
          this.startupFailures = [];
          return;
        } catch (err) {
          if (this.runtimeGeneration !== generation || ['draining', 'stopped'].includes(this.state)) {
            // Superseded or released: never fail or retry a runtime this call
            // no longer owns.
            throw err;
          }
          this.startupFailures.push({
            label: (this.client?.command ?? []).join(' ') || 'codex',
            message: err?.message || String(err),
            stderr: err?.details?.stderr ?? null,
          });
          if (this.#advanceToFallbackCli(attempt, attempts, err)) {
            continue;
          }
          this.#failRuntime(err);
          throw err;
        }
      }
    } finally {
      this.startupInFlight = false;
    }
  }

  /**
   * Swaps in the next CLI candidate after a start that died before READY.
   * The dead generation is detached first so its exit/error handlers (which
   * guard on identity) cannot fail the runtime we are about to start.
   *
   * @returns {boolean} true when another candidate took over
   */
  #advanceToFallbackCli(attempt, attempts, err) {
    if (attempt >= attempts || typeof this.clientFactory?.advance !== 'function') {
      return false;
    }
    const from = (this.client?.command ?? []).join(' ') || 'codex';
    const failed = this.client;
    this.client = null;
    const next = this.clientFactory.advance();
    if (!next) {
      this.client = failed;
      return false;
    }
    try { failed?.close(); } catch { /* the candidate is already gone */ }
    this.emit('runtimeFallback', {
      attempt,
      from,
      to: next.label ?? (next.command ?? []).join(' ') ?? null,
      reason: err?.message || String(err),
    });
    return true;
  }

  #attachClientHandlers(client) {
    client.on('notification', ({ method, params }) => {
      if (this.client === client) this.#handleNotification(method, params);
    });
    client.on('exited', (err) => {
      if (this.client === client) this.#transportFailure(err);
    });
    client.on('processError', (err) => {
      if (this.client === client) this.#transportFailure(err);
    });
    client.on('stdinError', (err) => {
      if (this.client === client) this.#transportFailure(err);
    });
    client.on('stderrLine', (line) => this.emit('stderrLine', line));
    client.on('protocolError', (err) => this.emit('protocolError', err));
    client.on('lateResponse', (entry) => {
      if (this.client !== client) return;
      const operation = [...this.operations.values()].find((candidate) => !candidate.settled && candidate.rpcId === entry.id);
      if (operation) {
        if (entry.payload.error) {
          this.#onOperationRpcError(operation, new ClassifiedError('RPC_ERROR',
            client.sanitizeDiagnostic?.(entry.payload.error.message) ?? 'Native operation was rejected',
            { rpcCode: entry.payload.error.code }));
        } else {
          this.#onOperationAck(operation, entry.payload.result);
        }
      }
      this.emit('lateResponse', { id: entry.id, matchedOperation: operation?.clientOperationId ?? null });
    });
    client.onServerRequest = async (method, params, ctx) => {
      // Reverse requests are forwarded non-blocking; the service keeps its
      // own typed routing and never auto-accepts.
      return this.#handleServerRequest(method, params, { ...ctx, client });
    };
  }

  async #waitForState(target, timeoutMs = 30_000) {
    if (this.state === target) {
      return;
    }
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.removeListener('runtimeStateChanged', onChange);
        rejectPromise(new ClassifiedError('STATE_TIMEOUT', `runtime did not reach ${target}`));
      }, timeoutMs);
      const onChange = ({ state }) => {
        if (state === target) {
          clearTimeout(timer);
          this.removeListener('runtimeStateChanged', onChange);
          resolvePromise();
        } else if (state === 'failed') {
          clearTimeout(timer);
          this.removeListener('runtimeStateChanged', onChange);
          rejectPromise(new ClassifiedError('RUNTIME_FAILED', 'runtime failed before reaching ' + target));
        } else if (state === 'stopped' && target === 'ready') {
          clearTimeout(timer);
          this.removeListener('runtimeStateChanged', onChange);
          rejectPromise(new ClassifiedError('RUNTIME_RESET', 'runtime was released before reaching ready'));
        }
      };
      this.on('runtimeStateChanged', onChange);
    });
  }

  /**
   * Single runtime failure finalization: settle all operations once, mark
   * threads unloaded (ids preserved), and allow a restart on the next op.
   */
  #failRuntime(err) {
    if (this.failureSettled) {
      return;
    }
    this.failureSettled = true;
    this.#setState('failed');
    const message = this.#runtimeFailureMessage(err);
    for (const operation of this.operations.values()) {
      this.#settleOperation(operation, {
        outcome: 'failed',
        error: message,
      });
    }
    this.operations.clear();
    this.activeOperationId = null;
    this.busy = false;
    this.queue = [];
    this.bootstrapInFlight = false;
    this.pendingInteractions.clear();
    this.itemSnapshots.clear();
    this.planItems.clear();
    // Thread ids survive; they are resumed after the next successful start.
    for (const thread of this.threads.values()) {
      thread.state = 'unloaded';
    }
    if (this.client) {
      try {
        this.client.close();
      } catch { /* already down */ }
    }
    this.emit('runtimeFailed', { message: err?.message || String(err) });
  }

  /**
   * Failure text shown in the chat error card. The client's canonical message
   * stays the prefix (history fallback and other consumers match on it); the
   * per-CLI diagnostics and an actionable hint are appended so a broken or
   * wrong CLI install is identifiable without reading idea.log.
   */
  #runtimeFailureMessage(err) {
    const base = `codex runtime failure: ${err?.message || err}`;
    const attempts = this.startupFailures ?? [];
    const details = attempts.map((attempt) => {
      const stderr = typeof attempt.stderr === 'string'
        ? attempt.stderr.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
      return `- ${attempt.label}: ${attempt.message}${stderr ? ` - ${stderr}` : ''}`;
    });
    if (details.length === 0 && Array.isArray(err?.details?.command)) {
      // The client attached its own launch facts (a start that died before the
      // handshake); report them even when no attempt bookkeeping was recorded.
      const stderr = typeof err.details.stderr === 'string'
        ? err.details.stderr.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
      details.push(`- ${err.details.command.join(' ')}: ${err?.message || err}${stderr ? ` - ${stderr}` : ''}`);
    }
    if (details.length === 0) {
      return base;
    }
    // Blank line + bullets so the markdown error card keeps the canonical exit
    // line as its own paragraph and lists which CLI failed and how.
    return [
      base,
      '',
      ...details,
      '- Codex CLI check: run "codex --version"; reinstall the CLI with'
        + ' "npm install -g @openai/codex@latest" after removing a stale global install,'
        + ' or point CODEX_BIN at a working binary (Settings > Provider Management > CLI).',
    ].join('\n');
  }

  #handleClientExit(err) {
    if (this.state === 'draining' || this.state === 'stopped') {
      return;
    }
    this.#failRuntime(err || new Error('codex app-server exited'));
  }

  /**
   * Transport death reported by the client's own events.
   *
   * A start that died before READY is finalized by the startup loop, which may
   * still swap in another CLI candidate - the client's `exited`/`processError`
   * events fire synchronously, before the pending handshake promise rejects, so
   * failing here would pre-empt the fallback (and report a bare exit code).
   */
  #transportFailure(err) {
    if (this.startupInFlight) {
      return;
    }
    this.#handleClientExit(err);
  }

  // ==========================================================================
  // Thread registry
  // ==========================================================================

  #isThreadLoaded(threadId) {
    const thread = this.threads.get(threadId);
    return !!thread && thread.state !== 'unloaded' && thread.state !== 'loading';
  }

  #recordThreadRelation(threadId, parentThreadId = null) {
    if (!threadId) {
      return null;
    }
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = {
        threadId,
        parentThreadId: parentThreadId ?? null,
        rootThreadId: parentThreadId ? this.#rootOf(parentThreadId) : threadId,
        state: 'unloaded',
        relationVerified: false,
      };
      this.threads.set(threadId, thread);
    } else if (parentThreadId && !thread.parentThreadId) {
      thread.parentThreadId = parentThreadId;
      thread.rootThreadId = this.#rootOf(parentThreadId);
      thread.relationVerified = false;
    }
    return thread;
  }

  #rootOf(threadId) {
    const seen = new Set();
    let current = threadId;
    while (current) {
      if (seen.has(current) || seen.size >= 32) return null;
      seen.add(current);
      const parent = this.threads.get(current)?.parentThreadId;
      if (!parent) return current;
      current = parent;
    }
    return null;
  }

  /**
   * Start a new thread (single flight per registry entry). `params` carries
   * cwd/model/approval/sandbox/developerInstructions for the native request.
   */
  async #startThread(params) {
    const response = await this.client.request('thread/start', params);
    const threadId = response?.thread?.id;
    if (!threadId) {
      throw new ClassifiedError('PROTOCOL', 'thread/start response did not include a thread id');
    }
    this.#recordThreadRelation(threadId);
    const thread = this.threads.get(threadId);
    thread.state = 'idle';
    thread.relationVerified = true;
    if (!this.rootThreadId) {
      this.rootThreadId = threadId;
    }
    this.threadTokenTotals.set(threadId, { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });
    this.emit('codex_event', this.#envelope({
      kind: 'threadStarted',
      threadId,
      payload: this.#redactNativeProjection({ thread: response.thread }, { threadId }),
    }));
    this.#rememberThreadSettings(threadId, response);
    return response;
  }

  /** Resume an existing thread. Never re-sends any user task. */
  async #resumeThread(threadId, { bootstrap = false } = {}) {
    if (this.#isThreadLoaded(threadId)) {
      return;
    }
    const client = this.client;
    const pending = this.threadResumes.get(threadId);
    if (pending?.client === client) {
      return await pending.promise;
    }
    const thread = this.#recordThreadRelation(threadId);
    thread.state = 'loading';
    if (bootstrap) {
      this.bootstrapInFlight = true;
    }
    // Preconnect and FIFO operations can arrive together while history loads.
    // Sharing the resume prevents two native requests from claiming one writer.
    const promise = (async () => {
      const response = await client.request('thread/resume', {
        threadId,
        config: this.launchOptions?.nativeConfig ?? undefined,
        modelProvider: this.launchOptions?.modelProvider ?? undefined,
        developerInstructions: this.launchOptions?.developerInstructions ?? undefined,
      });
      if (this.client !== client || !client.alive) {
        throw new ClassifiedError('RUNTIME_RESET', 'Codex runtime changed while resuming the thread');
      }
      thread.state = 'idle';
      thread.relationVerified = true;
      // A restored control can be the first write, without a preconnect binding the root.
      if (!this.rootThreadId) this.rootThreadId = threadId;
      if (!this.desiredThreadId) this.desiredThreadId = threadId;
      this.emit('codex_event', this.#envelope({
        kind: 'threadResumed',
        threadId,
        payload: this.#redactNativeProjection({ thread: response?.thread ?? null }, { threadId }),
      }));
      this.#rememberThreadSettings(threadId, response);
    })();
    const entry = { client, promise };
    this.threadResumes.set(threadId, entry);
    try {
      await promise;
    } catch (error) {
      if (this.client === client) thread.state = 'unloaded';
      throw error;
    } finally {
      if (this.threadResumes.get(threadId) === entry) this.threadResumes.delete(threadId);
      if (bootstrap) {
        this.bootstrapInFlight = false;
      }
    }
  }

  /**
   * Bind a thread to the service root (used by preconnect with a saved id).
   */
  async bindThread(threadId) {
    this.desiredThreadId = threadId;
    this.#recordThreadRelation(threadId);
  }

  #rememberThreadSettings(threadId, response) {
    const thread = response?.thread ?? {};
    const settings = {
      model: response?.model ?? thread.model,
      modelProvider: response?.modelProvider ?? thread.modelProvider,
      cwd: response?.cwd ?? thread.cwd,
      effort: response?.reasoningEffort ?? thread.reasoningEffort,
      approvalPolicy: response?.approvalPolicy ?? thread.approvalPolicy,
      approvalsReviewer: response?.approvalsReviewer ?? thread.approvalsReviewer,
      sandboxPolicy: response?.sandbox ?? thread.sandbox,
      collaborationMode: response?.collaborationMode ?? thread.collaborationMode,
      serviceTier: response?.serviceTier !== undefined ? response.serviceTier : thread.serviceTier,
    };
    this.#handleEffectiveSettings({ threadId, threadSettings: Object.fromEntries(
      Object.entries(settings).filter(([, value]) => value !== undefined)),
    });
  }

  // ==========================================================================
  // Operations: registration, FIFO, phases
  // ==========================================================================

  #createOperation({ kind, threadId, clientMessageId = null, markerPayload = null }) {
    const clientOperationId = `op-${this.runtimeGeneration}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const operation = {
      clientOperationId,
      kind,
      threadId: threadId ?? null,
      rootThreadId: threadId ? this.#rootOf(threadId) : (this.rootThreadId ?? null),
      clientMessageId,
      dispatchPhase: 'notWritten',
      cancelRequested: false,
      nativeTurnId: null,
      settled: false,
      outcome: null,
      markerPayload,
      frozenSettings: null,
      cancelTimer: null,
      emitter: null,
    };
    this.operations.set(clientOperationId, operation);
    return operation;
  }

  /** Emit the legacy marker through the operation-captured emitter (D4). */
  #emitOperationMarker(operation, event) {
    if (operation.emitter && typeof operation.emitter === 'function') {
      operation.emitter(event);
    } else if (this.emitMarker) {
      this.emitMarker(operation, event);
    }
  }

  #envelope({ kind, threadId = null, turnId = null, itemId = null, clientOperationId = null, payload = {} }) {
    const thread = threadId ? this.threads.get(threadId) : null;
    return {
      type: 'daemon',
      event: 'codex_event',
      provider: 'codex',
      runtimeGeneration: this.runtimeGeneration,
      channelId: this.channelId,
      sessionEpoch: this.sessionEpoch,
      clientOperationId: clientOperationId ?? null,
      rootThreadId: thread?.rootThreadId ?? this.rootThreadId,
      threadId: threadId ?? null,
      turnId: turnId ?? null,
      itemId: itemId ?? null,
      kind,
      payload,
    };
  }

  /**
   * Queue a send/compact/review operation. Returns the operation id; the
   * promise (optionally awaited by the daemon) settles with the operation
   * outcome exactly once at the native terminal.
   */
  enqueueOperation({ kind, threadId, clientMessageId = null, settings = undefined, markerPayload = null }) {
    if (!OPERATION_KINDS.includes(kind)) {
      throw new Error(`unknown operation kind: ${kind}`);
    }
    // Repeated manual controls must share one native operation instead of
    // queueing duplicate compaction/review requests for the same thread.
    if (kind === 'compact' || kind === 'review') {
      const existing = [...this.operations.values(), ...this.queue].find((candidate) =>
        !candidate.settled
        && candidate.kind === kind
        && (candidate.threadId ?? this.rootThreadId) === (threadId ?? this.rootThreadId));
      if (existing) {
        return existing;
      }
    }
    const operation = this.#createOperation({ kind, threadId, clientMessageId, markerPayload });
    // Freeze the latest desired settings revision at enqueue time (D8).
    operation.frozenSettings = settings !== undefined
      ? structuredClone({ ...(this.desiredSettings || {}), ...settings })
      : this.#freezeDesiredSettings();
    if (settings !== undefined && kind === 'send') {
      this.desiredSettings = { ...(this.desiredSettings || {}), ...structuredClone(settings) };
    }
    const promise = new Promise((resolvePromise) => {
      operation.settlePromise = resolvePromise;
    });
    operation.promise = promise;
    this.queue.push(operation);
    this.emit('codex_event', this.#envelope({
      kind: 'operationQueued',
      clientOperationId: operation.clientOperationId,
      payload: { kind, queueLength: this.queue.length },
    }));
    this.#drainQueue();
    return operation;
  }

  /** Session FIFO: one active operation; messages sent during a turn queue. */
  #drainQueue() {
    if (this.busy || this.queue.length === 0 || this.state === 'draining') {
      // A launch-config change recorded while draining is applied when the
      // settled operation's idle boundary runs #maybeRebuildAtIdleBoundary().
      return;
    }
    if (this.state !== 'ready') {
      // Bring the runtime up first (first send or recovery); draining
      // continues once READY. A failed start fails the queued set once.
      this.ensureRuntime()
        .then(() => this.#drainQueue())
        .catch((err) => {
          for (const operation of this.queue.splice(0)) {
            this.#settleOperation(operation, {
              outcome: 'failed',
              error: `runtime unavailable: ${err?.message || err}`,
            });
          }
        });
      return;
    }
    const operation = this.queue.shift();
    this.activeOperationId = operation.clientOperationId;
    this.busy = true;
    this.#dispatchOperation(operation).catch((err) => {
      this.#settleOperation(operation, { outcome: 'failed', error: err?.message || String(err) });
    });
  }

  async #dispatchOperation(operation) {
    try {
      await this.ensureRuntime();
      if (operation.settled) {
        return;
      }
      // Stop may have requested cancellation while the runtime was starting.
      if (operation.cancelRequested && operation.dispatchPhase === 'notWritten') {
        this.#settleOperation(operation, { outcome: 'cancelled', error: 'cancelled before dispatch' });
        return;
      }

      // Thread bootstrap: start or resume BEFORE the operation RPC.
      this.bootstrapInFlight = true;
      let threadId = operation.threadId || this.rootThreadId || this.desiredThreadId;
      operation.threadId = threadId;
      try {
        if (!threadId || !this.#isThreadLoaded(threadId)) {
          if (threadId) {
            await this.#resumeThread(threadId);
            if (operation.frozenSettings && !operation.frozenSettings.cwdExplicit && this.effectiveSettings?.cwd) {
              operation.frozenSettings.cwd = this.effectiveSettings.cwd;
            }
          } else {
            const response = await this.#startThread(this.#threadStartParams(operation));
            threadId = response.thread.id;
            operation.threadId = threadId;
            operation.rootThreadId = threadId;
          }
        }
      } finally {
        this.bootstrapInFlight = false;
      }

      if (operation.settled || operation.cancelRequested) {
        // Cancelled during bootstrap: no operation RPC was written.
        this.#settleOperation(operation, { outcome: 'cancelled', error: 'cancelled during bootstrap' });
        return;
      }

      const mode = operation.frozenSettings?.collaborationMode;
      if (operation.frozenSettings && !operation.frozenSettings.cwdExplicit && this.effectiveSettings?.cwd) {
        operation.frozenSettings.cwd = this.effectiveSettings.cwd;
        if (this.desiredSettings && !this.desiredSettings.cwdExplicit) this.desiredSettings.cwd = this.effectiveSettings.cwd;
      }
      if (mode?.settings && !mode.settings.model && this.effectiveSettings?.model) {
        // A mode-only UI selection inherits the active model and effort before confirmation.
        mode.settings.model = operation.frozenSettings.model || this.effectiveSettings.model;
        if (mode.settings.reasoning_effort == null) {
          mode.settings.reasoning_effort = operation.frozenSettings.effort ?? this.effectiveSettings.effort ?? null;
        }
      }

      // Settings revision gate (D8): compact/review carry no settings param;
      // wait until the effective settings match the frozen revision.
      if (operation.kind !== 'send' && operation.frozenSettings) {
        const applied = await this.#applyDesiredSettings(operation.frozenSettings, operation.threadId);
        // Stop can release this control while its settings RPC is still pending.
        if (operation.settled) return;
        if (!applied) {
          await this.resetRuntime({ reason: 'unconfirmed-settings',
            failure: 'settings did not take effect before dispatch' });
          return;
        }
      }
      if (operation.settled || operation.cancelRequested) {
        this.#settleOperation(operation, { outcome: 'cancelled', error: 'cancelled before dispatch' });
        return;
      }
      this.#writeOperationRpc(operation);
    } catch (err) {
      if (operation.settled) return;
      // Native explicit rejections fail the operation directly; uncertainty
      // (written-but-unconfirmed) never lands here because request() threw
      // only after the write was refused.
      const phase = operation.dispatchPhase;
      if (phase === 'notWritten' && err?.phase === 'writtenUnconfirmed') {
        // The child state is unconfirmed, so no queued operation may write
        // before the reset: block settle's queue dispatch via the draining
        // gate, then settle "failed" — resetRuntime would mark it cancelled.
        this.#setState('draining');
        this.#settleOperation(operation, { outcome: 'failed', error: err.message });
        await this.resetRuntime({ reason: 'uncertain-bootstrap' });
        return;
      }
      if (phase === 'notWritten') {
        this.#settleOperation(operation, { outcome: 'failed', error: err?.message || String(err) });
      } else {
        // Written: treat as uncertain — the cancel/confirm budget handles it.
        operation.dispatchPhase = 'writtenUnconfirmed';
        this.#armUncertaintyWatch(operation);
      }
    }
  }

  #threadStartParams(operation) {
    const settings = operation.frozenSettings || {};
    return {
      cwd: settings.cwd ?? undefined,
      model: settings.model ?? undefined,
      modelProvider: settings.modelProvider ?? this.launchOptions?.modelProvider ?? undefined,
      approvalPolicy: settings.approvalPolicy ?? undefined,
      approvalsReviewer: settings.approvalsReviewer ?? undefined,
      sandbox: settings.sandbox ?? undefined,
      ephemeral: settings.ephemeral ?? undefined,
      developerInstructions: settings.developerInstructions ?? undefined,
      baseInstructions: undefined, // never override the model's base instructions (D6)
      config: settings.config ?? this.launchOptions?.nativeConfig ?? undefined,
    };
  }

  #writeOperationRpc(operation) {
    const threadId = operation.threadId;
    if (operation.kind === 'send') {
      const params = {
        threadId,
        input: operation.markerPayload?.input ?? [],
        ...(operation.clientMessageId ? { clientUserMessageId: operation.clientMessageId } : {}),
        ...this.#turnSettingsParams(operation.frozenSettings),
      };
      operation.dispatchPhase = 'writtenUnconfirmed';
      this.client.request('turn/start', params, { timeoutMs: 30_000, onDispatch: (id) => { operation.rpcId = id; } })
        .then((result) => this.#onOperationAck(operation, result))
        .catch((err) => this.#onOperationRpcError(operation, err));
      return;
    }
    if (operation.kind === 'compact') {
      operation.dispatchPhase = 'writtenUnconfirmed';
      this.client.request('thread/compact/start', { threadId }, { timeoutMs: 30_000, onDispatch: (id) => { operation.rpcId = id; } })
        .then(() => this.#onOperationAck(operation))
        .catch((err) => this.#onOperationRpcError(operation, err));
      return;
    }
    // review
    operation.dispatchPhase = 'writtenUnconfirmed';
    this.client.request('review/start', { threadId, target: { type: 'uncommittedChanges' } },
      { timeoutMs: 30_000, onDispatch: (id) => { operation.rpcId = id; } })
      .then((result) => this.#onOperationAck(operation, result))
      .catch((err) => this.#onOperationRpcError(operation, err));
  }

  #turnSettingsParams(settings) {
    if (!settings) {
      return {};
    }
    const params = {};
    if (settings.model) {
      params.model = settings.model;
    }
    if (settings.effort) {
      params.effort = settings.effort;
    }
    if (settings.collaborationMode) {
      params.collaborationMode = settings.collaborationMode;
    }
    if (settings.approvalPolicy) {
      params.approvalPolicy = settings.approvalPolicy;
    }
    if (settings.approvalsReviewer) {
      params.approvalsReviewer = settings.approvalsReviewer;
    }
    if (settings.sandbox) {
      params.sandboxPolicy = nativeSandboxPolicy(settings.sandbox);
    }
    if (settings.serviceTier !== undefined) {
      params.serviceTier = settings.serviceTier;
    }
    if (settings.cwd) {
      params.cwd = settings.cwd;
    }
    return params;
  }

  /**
   * RPC ack: acceptance only. The operation still waits for the native turn
   * identity or terminal — an ack never ends a turn (D3).
   */
  #onOperationAck(operation, result = {}) {
    if (operation.settled) {
      return;
    }
    if (result?.turn?.id) this.#bindOperationByTurn(operation.threadId, result.turn.id);
    this.emit('codex_event', this.#envelope({
      kind: 'operationAcked',
      clientOperationId: operation.clientOperationId,
      threadId: operation.threadId,
      payload: { kind: operation.kind },
    }));
    // Compact acknowledges submission before capture_step_context announces its
    // turn; that announcement gets its own longer budget instead of none at all.
    if (operation.kind === 'compact' && !operation.cancelRequested) {
      if (operation.cancelTimer) clearTimeout(operation.cancelTimer);
      operation.cancelTimer = null;
      this.#armUncertaintyWatch(operation, this.compactAnnouncementBudgetMs);
      return;
    }
    this.#armUncertaintyWatch(operation);
  }

  /** RPC error: only a definitive native rejection may fail the operation. */
  #onOperationRpcError(operation, err) {
    if (operation.settled) {
      return;
    }
    if (err?.code === 'RPC_TIMEOUT') {
      // Written-but-unconfirmed: keep FIFO/lease occupancy; the watch handles
      // reconciliation or child termination.
      if (operation.nativeTurnId) return;
      this.#armUncertaintyWatch(operation);
      return;
    }
    if (operation.dispatchPhase === 'notWritten') {
      this.#settleOperation(operation, { outcome: 'failed', error: err?.message || String(err) });
      return;
    }
    // A native explicit rejection arrives as RPC_ERROR; anything else stays
    // uncertain. Errors during a retrying turn are never terminals (D3).
    if (err?.code === 'RPC_ERROR' && !operation.nativeTurnId) {
      this.#settleOperation(operation, { outcome: 'failed', error: err?.message || String(err) });
      return;
    }
    this.#armUncertaintyWatch(operation);
  }

  /**
   * Uncertainty watch: if a written operation produces neither a native turn
   * identity nor a terminal within the stop budget, close the child and settle
   * from its exit (D3). No status probe exists for these methods, so an
   * unconfirmable dispatch is indistinguishable from a wedged child.
   */
  #armUncertaintyWatch(operation, budgetMs = this.stopBudgetMs) {
    if (operation.cancelTimer || operation.settled
        || (operation.nativeTurnId && !operation.cancelRequested)) {
      return;
    }
    operation.cancelTimer = setTimeout(() => {
      if (operation.settled) {
        return;
      }
      // Budget exceeded with either no native identity (dispatch unproven) or
      // an un-terminated known turn: the child is the only remaining source
      // of truth, so close it and settle from its exit.
      this.#terminateUncertainRuntime(operation);
    }, Math.max(0, budgetMs - (operation.cancelRequestedAt ? Date.now() - operation.cancelRequestedAt : 0)));
    operation.cancelTimer.unref?.();
  }

  async #terminateUncertainRuntime(operation) {
    this.emit('codex_event', this.#envelope({
      kind: 'runtimeUnhealthy',
      clientOperationId: operation.clientOperationId,
      payload: { reason: 'uncertain dispatch could not be reconciled' },
    }));
    const child = this.client;
    if (!child || operation.settled) return;
    try {
      child.close();
    } catch { /* already down */ }
    // Wait for the child exit confirmation before the single failure settle.
    await child.waitForExit();
    if (!operation.settled) {
      this.#settleOperation(operation, {
        outcome: 'failed',
        error: 'operation could not be confirmed; runtime was closed after child exit',
      });
    }
  }

  /**
   * Single finalization gate. Terminal states, operation done, EOF — all
   * converge here; the second caller is a no-op.
   */
  #settleOperation(operation, { outcome, error = null }) {
    if (error && this.client?.sanitizeDiagnostic) error = this.client.sanitizeDiagnostic(error);
    if (operation.settled) {
      return;
    }
    for (const item of this.itemSnapshots.values()) {
      if (['reasoning', 'contextCompaction', 'commandExecution', 'mcpToolCall', 'fileChange', 'imageView', 'imageGeneration', 'webSearch', 'dynamicToolCall', 'collabAgentToolCall'].includes(item.type)
          && operation.itemDisplayIdentities?.has(item.id) && item.threadId === operation.threadId
          && (item.turnId === operation.nativeTurnId || item.turnId == null && operation.kind === 'compact')
          && !['completed', 'failed', 'declined', 'interrupted'].includes(item.status)
          && (outcome !== 'completed' || item.type === 'reasoning')) {
        const terminal = { ...item, status: outcome === 'cancelled' ? 'interrupted' : outcome };
        this.#rememberItemSnapshot(item.threadId, item.turnId, terminal);
        this.#emitItemMarkers(operation, terminal, { authoritative: true });
      }
    }
    operation.settled = true;
    operation.outcome = outcome;
    operation.dispatchPhase = 'terminal';
    for (const [key, item] of this.itemSnapshots) {
      if (item.threadId === operation.threadId && operation.itemDisplayIdentities?.has(item.id)
          && (item.turnId === operation.nativeTurnId || item.turnId == null)) this.itemSnapshots.delete(key);
    }
    if (operation.cancelTimer) {
      clearTimeout(operation.cancelTimer);
      operation.cancelTimer = null;
    }
    this.operations.delete(operation.clientOperationId);
    this.emit('codex_event', this.#envelope({
      kind: 'operationDone',
      clientOperationId: operation.clientOperationId,
      threadId: operation.threadId,
      turnId: operation.nativeTurnId,
      payload: { outcome, error, kind: operation.kind },
    }));
    this.#emitOperationMarker(operation, {
      marker: 'OPERATION_DONE',
      clientOperationId: operation.clientOperationId,
      outcome,
      error,
    });
    if (this.activeOperationId === operation.clientOperationId) {
      this.activeOperationId = null;
      this.busy = false;
    }
    if (this.state === 'ready' && !this.failureSettled) {
      this.#drainQueue();
      this.#maybeRebuildAtIdleBoundary();
    }
    operation.settlePromise?.({ outcome, error });
  }

  // ==========================================================================
  // Launch-config rebuild at idle boundaries (2.4 / 4.6)
  // ==========================================================================

  /**
   * Record new launch inputs. A fingerprint change rebuilds the child at the
   * next idle boundary (queue empty, no active turn, no bootstrap), then
   * cold-resumes the root thread. Ordinary model/effort changes never reach
   * here — they travel through turn settings.
   */
  notifyLaunchConfigChange(launchOptions, fingerprint) {
    if (this.runtimeFingerprint && this.runtimeFingerprint === fingerprint) {
      return { rebuild: 'none' };
    }
    this.runtimeFingerprint = fingerprint;
    this.launchOptions = launchOptions ?? this.launchOptions;
    this.pendingRebuild = true;
    const idle = !this.busy && this.queue.length === 0 && !this.bootstrapInFlight
      && this.state === 'ready';
    this.#maybeRebuildAtIdleBoundary();
    return { rebuild: idle ? 'immediate' : 'deferred' };
  }

  #maybeRebuildAtIdleBoundary() {
    if (!this.pendingRebuild) {
      return;
    }
    if (this.busy || this.bootstrapInFlight || this.queue.length > 0
        || this.state !== 'ready') {
      // Busy or non-empty queue: the rebuild happens at the next empty-queue
      // boundary (D3); queued operations keep their dispatch order.
      return;
    }
    this.pendingRebuild = false;
    this.#rebuildRuntime().then(() => this.#drainQueue())
      .catch(() => { /* surfaced via runtimeFailed */ });
  }

  async #rebuildRuntime() {
    await this.resetRuntime({ reason: 'launch-config-change' });
    await this.ensureRuntime();
    // Cold resume applies new developer instructions and clears temporary
    // acceptForSession/session grants (upper layer listens for threadResumed).
    const resumeTarget = this.desiredThreadId ?? this.rootThreadId;
    if (resumeTarget && !this.#isThreadLoaded(resumeTarget)) {
      await this.#resumeThread(resumeTarget, { bootstrap: true });
    }
  }

  // ==========================================================================
  // Native notification handling
  // ==========================================================================

  #handleNotification(method, params) {
    if (typeof method === 'string' && (method === 'serverRequest/resolved' || /\/resolved$/.test(method))) {
      const rpcId = params?.requestId ?? params?.rpcId;
      this.pendingInteractions.delete(rpcId);
      this.client?.serverRequests?.delete(rpcId);
      this.emit('codex_event', this.#envelope({
        kind: 'interactionResolved',
        threadId: params?.threadId ?? null,
        turnId: params?.turnId ?? null,
        itemId: params?.itemId ?? null,
        payload: { method, ...(params ?? {}) },
      }));
      return;
    }
    switch (method) {
      case 'thread/name/updated': {
        const threadId = params?.threadId;
        const name = params?.threadName;
        const thread = this.threads.get(threadId);
        if (thread) thread.name = name ?? null;
        this.emit('codex_event', this.#envelope({ kind: 'threadNameUpdated', threadId,
          payload: { threadName: name ?? null } }));
        break;
      }
      case 'error': {
        const reason = params?.error?.message ?? 'Codex reported an error';
        this.emit('codex_event', this.#envelope({
          kind: 'nativeWarning',
          threadId: params?.threadId ?? null,
          turnId: params?.turnId ?? null,
          payload: { message: this.client?.sanitizeDiagnostic?.(reason) ?? reason, willRetry: params?.willRetry === true },
        }));
        // The native turn terminal, rather than a retry notice, releases its writer.
        break;
      }
      case 'turn/started':
        this.#handleTurnStarted(params);
        break;
      case 'turn/completed':
        this.#handleTurnCompleted(params);
        break;
      case 'turn/aborted':
        this.#handleTurnAborted(params);
        break;
      case 'item/started':
      case 'item/completed':
      case 'item/updated':
        this.#handleItemEvent(method, params);
        break;
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/textDelta':
      case 'item/plan/delta':
      case 'item/commandExecution/outputDelta':
      case 'command/exec/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/fileChange/patchUpdated':
      case 'item/mcpToolCall/progress':
        this.#handleItemDelta(method, params);
        break;
      case 'thread/tokenUsage/updated':
        this.#handleThreadScopedEvent(method, params);
        break;
      case 'thread/settings/updated':
        this.#handleEffectiveSettings(params);
        break;
      case 'turn/plan/updated':
        this.#handleThreadScopedEvent(method, params);
        break;
      case 'turn/diff/updated':
        this.#handleThreadScopedEvent(method, params);
        break;
      case 'thread/compacted':
        this.#handleThreadCompacted(params);
        break;
      default:
        // Unknown notifications are surfaced, never fatal (D2).
        this.emit('codex_event', this.#envelope({
          kind: 'nativeNotification',
          threadId: params?.threadId ?? null,
          turnId: params?.turnId ?? null,
          payload: { method, summary: summarizeNotification(this.privacyIndex?.redact(params ?? {}, {
            threadId: params?.threadId, turnId: params?.turnId,
          }) ?? params) },
        }));
    }
  }

  #bindOperationByTurn(threadId, turnId) {
    if (this.completedTurns.has(`${threadId}:${turnId}`)) return null;
    // Find an operation on this thread whose native turn matches, or bind a
    // written-unconfirmed operation to its first native identity.
    for (const operation of this.operations.values()) {
      if (operation.threadId === threadId && operation.nativeTurnId === turnId) {
        return operation;
      }
    }
    for (const operation of this.operations.values()) {
      if (operation.threadId === threadId && !operation.nativeTurnId
          && operation.dispatchPhase === 'writtenUnconfirmed') {
        operation.nativeTurnId = turnId;
        operation.dispatchPhase = 'nativeTurnKnown';
        if (operation.cancelTimer && !operation.cancelRequested) {
          clearTimeout(operation.cancelTimer);
          operation.cancelTimer = null;
        }
        // Stop intent applies immediately once the identity is known (D3).
        if (operation.cancelRequested) {
          this.#interruptNativeTurn(operation);
        }
        return operation;
      }
    }
    return null;
  }

  #handleTurnStarted(params) {
    const threadId = params?.threadId;
    const turnId = params?.turn?.id;
    if (!threadId || !turnId) {
      return;
    }
    // Native started is the explicit boundary for a new turn. Test peers may
    // recycle ids; a terminal alone can never establish that boundary.
    this.completedTurns.delete(`${threadId}:${turnId}`);
    for (const [key, item] of this.planItems) {
      if (item.threadId === threadId && item.turnId !== turnId) this.planItems.delete(key);
    }
    this.#recordThreadRelation(threadId);
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.state = 'running';
    }
    const operation = this.#bindOperationByTurn(threadId, turnId);
    if (operation) {
      this.#emitOperationMarker(operation, `[THREAD_ID] ${threadId}`);
      this.#emitOperationMarker(operation, '[STREAM_START]');
    }
    this.emit('codex_event', this.#envelope({
      kind: 'turnStarted',
      threadId,
      turnId,
      clientOperationId: operation?.clientOperationId ?? null,
      payload: {},
    }));
    // Child turns never bind to a parent operation (D1/D3): the envelope
    // carries the real thread identity and no fabricated parent id.
  }

  #handleTurnCompleted(params) {
    const threadId = params?.threadId;
    const turnId = params?.turn?.id;
    const status = params?.turn?.status;
    if (!threadId || !turnId || !TERMINAL_TURN_STATUSES.has(status)) {
      return;
    }
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.state = 'idle';
    }
    const operation = this.#bindOperationByTurn(threadId, turnId);
    this.completedTurns.add(`${threadId}:${turnId}`);
    if (this.completedTurns.size > 2048) this.completedTurns.delete(this.completedTurns.values().next().value);
    if (operation) {
      this.#emitOperationMarker(operation, '[STREAM_END]');
      if (params?.turn?.usage) {
        this.#emitOperationMarker(operation, `[MESSAGE] ${JSON.stringify({
          type: 'result',
          usage: normalizeUsage(params.turn.usage),
          session_id: threadId,
        })}`);
      }
    }
    if (operation && !operation.settled) {
      const outcome = status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed';
      this.#settleOperation(operation, { outcome, error: status === 'failed' ? (params?.turn?.error?.message ?? 'turn failed') : null });
    } else if (!operation) {
      // Late terminal for an unknown operation (e.g. after rebuild): surface
      // for diagnostics, never resurrect settled work.
      this.emit('codex_event', this.#envelope({
        kind: 'orphanTurnTerminal',
        threadId,
        turnId,
        payload: { status },
      }));
    }
    // The browser and native rollout own the transcript. Keeping completed
    // output here would make a persistent chat retain every past tool result.
    for (const [key, item] of this.itemSnapshots) {
      if (item.threadId === threadId && item.turnId === turnId) this.itemSnapshots.delete(key);
    }
    for (const [key, item] of this.planItems) {
      // The completed plan still backs the user's next-turn decision.
      if (item.threadId === threadId && item.turnId === turnId
          && (status !== 'completed' || !item.authoritative)) this.planItems.delete(key);
    }
  }

  #handleTurnAborted(params) {
    const threadId = params?.threadId;
    const turnId = params?.turn?.id ?? params?.turnId ?? null;
    if (!threadId) {
      return;
    }
    const operation = turnId
      ? this.#bindOperationByTurn(threadId, turnId)
      : [...this.operations.values()].find((candidate) =>
        !candidate.settled && candidate.threadId === threadId);
    if (operation) {
      this.#emitOperationMarker(operation, '[STREAM_END]');
    }
    this.emit('codex_event', this.#envelope({
      kind: 'turnAborted',
      threadId,
      turnId,
      clientOperationId: operation?.clientOperationId ?? null,
      payload: {},
    }));
  }

  #handleItemEvent(method, params) {
    const threadId = params?.threadId;
    if (!threadId) {
      return;
    }
    this.#recordThreadRelation(threadId);
    const turnId = params?.turnId ?? null;
    const itemId = params?.item?.id ?? null;
    const itemType = params?.item?.type ?? params?.item?.itemType ?? null;
    let safeItem = this.privacyIndex?.redact(params?.item, { threadId, turnId, itemId }) ?? params?.item;
    if (['contextCompaction', 'reasoning'].includes(itemType) && safeItem && !safeItem.status) {
      safeItem = { ...safeItem, status: method === 'item/completed' ? 'completed' : 'inProgress' };
    }
    if (!turnId || !this.completedTurns.has(`${threadId}:${turnId}`)) {
      this.#rememberItemSnapshot(threadId, turnId, safeItem);
    }
    const operation = turnId
      ? this.#bindOperationByTurn(threadId, turnId)
      : [...this.operations.values()].find((candidate) =>
        !candidate.settled && candidate.threadId === threadId);
    if (operation && (method === 'item/completed' || method === 'item/updated'
        || method === 'item/started' && ['reasoning', 'commandExecution', 'mcpToolCall', 'fileChange', 'contextCompaction',
          'dynamicToolCall', 'collabAgentToolCall', 'imageView', 'imageGeneration', 'webSearch'].includes(itemType))) {
      this.#emitItemMarkers(operation, this.itemSnapshots.get(this.#itemSnapshotKey(threadId, itemId)) ?? safeItem, {
        authoritative: method === 'item/completed',
      });
    }
    if (itemType === 'plan' && itemId && (!turnId || !this.completedTurns.has(`${threadId}:${turnId}`))) {
      const plan = this.#upsertPlanItem(threadId, turnId, params.item, method === 'item/completed');
      this.emit('codex_event', this.#envelope({
        kind: 'planUpdated',
        threadId,
        turnId,
        itemId,
        clientOperationId: operation?.clientOperationId ?? null,
        payload: { item: plan, authoritative: method === 'item/completed' },
      }));
    }
    if (itemType === 'fileChange' || itemType === 'file_change') {
      this.emit('codex_event', this.#envelope({
        kind: 'fileChangeUpdated',
        threadId,
        turnId,
        itemId,
        clientOperationId: operation?.clientOperationId ?? null,
        payload: { item: safeItem ?? null, authoritative: method === 'item/completed' },
      }));
    }
    this.emit('codex_event', this.#envelope({
      kind: method === 'item/started' ? 'itemStarted' : method === 'item/completed' ? 'itemCompleted' : 'itemUpdated',
      threadId,
      turnId,
      itemId,
      clientOperationId: operation?.clientOperationId ?? null,
      payload: { item: safeItem ?? null },
    }));
  }

  #handleThreadScopedEvent(method, params) {
    const threadId = params?.threadId ?? params?.thread_id ?? null;
    const turnId = params?.turnId ?? params?.turn_id ?? null;
    // Cold resume replays the previous turn's usage after turn/start has been written.
    // Statistics and plan/diff snapshots cannot establish a new operation's native identity.
    const operation = threadId && turnId ? [...this.operations.values()].find(candidate =>
      candidate.threadId === threadId && candidate.nativeTurnId === turnId) : null;
    if (operation && method === 'turn/plan/updated') {
      this.#emitPlanMarker(operation, params?.plan ?? []);
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = params?.tokenUsage ?? params?.token_usage ?? params?.usage;
      if (usage) {
        const last = normalizeUsage(usage.last ?? usage);
        const total = usage.total ? normalizeUsage(usage.total) : null;
        if (operation) {
          if (total) {
            operation.usageBaseline ??= this.threadTokenTotals.get(threadId)
              ?? subtractUsage(total, last);
            operation.turnUsage = subtractUsage(total, operation.usageBaseline);
          } else {
            operation.turnUsage = last;
          }
          this.#emitOperationMarker(operation, `[MESSAGE] ${JSON.stringify({
            type: 'event_msg', payload: { type: 'token_count', info: {
              last_token_usage: last,
              model_context_window: usage.modelContextWindow ?? usage.model_context_window,
            } },
          })}`);
          this.#emitOperationMarker(operation, `[MESSAGE] ${JSON.stringify({
            type: 'result',
            usage: operation.turnUsage,
            session_id: threadId,
          })}`);
        }
        if (total && threadId) this.threadTokenTotals.set(threadId, total);
      }
    }
    this.emit('codex_event', this.#envelope({
      kind: method,
      threadId,
      turnId,
      payload: params ?? {},
    }));
  }

  #handleThreadCompacted(params) {
    const threadId = params?.threadId ?? null;
    const turnId = params?.turnId ?? null;
    const operation = threadId && turnId
      ? this.#bindOperationByTurn(threadId, turnId)
      : [...this.operations.values()].find((candidate) =>
        !candidate.settled && candidate.threadId === threadId);
    // The deprecated notification carries no summary on some native versions.
    // Its boundary is still visible; the enclosing turn keeps its own terminal.
    const summary = params?.summary ?? params?.text ?? params?.message ?? '';
    const canonical = [...(operation?.itemDisplayIdentities?.keys() ?? [])]
      .map(itemId => this.itemSnapshots.get(this.#itemSnapshotKey(threadId, itemId)))
      .find(item => item?.type === 'contextCompaction');
    if (operation && canonical?.status !== 'completed') {
      const item = { ...canonical, id: canonical?.id ?? params?.itemId ?? `codex-compaction-${operation.clientOperationId}:${turnId ?? ''}`,
        type: 'contextCompaction', status: 'completed',
        text: summary || canonical?.text || '', trigger: operation.kind === 'compact' ? 'manual' : 'auto' };
      this.#rememberItemSnapshot(threadId, turnId, item);
      this.#emitItemMarkers(operation, item, { authoritative: true });
    }
    this.emit('codex_event', this.#envelope({
      kind: 'contextCompaction',
      threadId,
      turnId,
      clientOperationId: operation?.clientOperationId ?? null,
      payload: {
        trigger: operation?.kind === 'compact' ? 'manual' : 'auto',
        ...params,
      },
    }));
  }

  #handleItemDelta(method, params) {
    const threadId = params?.threadId ?? params?.thread_id ?? null;
    const turnId = params?.turnId ?? params?.turn_id ?? null;
    if (turnId && this.completedTurns.has(`${threadId}:${turnId}`)) return;
    const operation = threadId && turnId ? this.#bindOperationByTurn(threadId, turnId) : null;
    const delta = params?.delta ?? params?.text ?? params?.content ?? '';
    if (method === 'item/fileChange/patchUpdated' && params?.itemId) {
      this.#rememberItemSnapshot(threadId, turnId, {
        id: params.itemId,
        type: 'fileChange',
        changes: params.changes ?? [],
      });
    }
    if (method.includes('plan') && params?.itemId) {
      const key = `${threadId ?? ''}:${params.itemId}`;
      const previous = this.planItems.get(key) ?? {
        id: params.itemId,
        threadId,
        turnId,
        type: 'plan',
        text: '',
        status: 'streaming',
      };
      const next = {
        ...previous,
        threadId,
        turnId,
        text: `${previous.text ?? ''}${typeof delta === 'string' ? delta : ''}`,
        authoritative: false,
      };
      this.planItems.set(key, next);
      this.emit('codex_event', this.#envelope({
        kind: 'planUpdated',
        threadId,
        turnId,
        itemId: params.itemId,
        clientOperationId: operation?.clientOperationId ?? null,
        payload: { item: next, delta, authoritative: false },
      }));
    }
    if (operation && typeof delta === 'string' && delta.length > 0
        && ['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method)) {
      if (params?.itemId) {
        const key = this.#itemSnapshotKey(threadId, params.itemId);
        const previous = this.itemSnapshots.get(key) ?? { id: params.itemId };
        const reasoning = method.includes('reasoning');
        const field = reasoning ? (method.includes('summary') ? 'summary' : 'content') : 'text';
        const prefix = previous[field] ?? (!reasoning && Array.isArray(previous.content)
          ? previous.content.filter(block => ['text', 'input_text', 'output_text'].includes(block?.type))
            .map(block => block.text ?? '').join('') : '');
        const text = `${Array.isArray(prefix) ? prefix.map(entry => typeof entry === 'string' ? entry : entry?.text ?? '').join('') : prefix}${delta}`;
        const item = { ...previous, type: reasoning ? 'reasoning' : 'agentMessage',
          [field]: reasoning ? [text] : text };
        if (!reasoning) delete item.content;
        this.#rememberItemSnapshot(threadId, turnId, item);
        this.#emitItemMarkers(operation, item);
      } else {
        const marker = method.includes('reasoning') ? '[THINKING_DELTA]' : '[CONTENT_DELTA]';
        this.#emitOperationMarker(operation, `${marker} ${JSON.stringify(delta)}`);
      }
    }
    this.emit('codex_event', this.#envelope({
      kind: method,
      threadId,
      turnId,
      clientOperationId: operation?.clientOperationId ?? null,
      payload: this.privacyIndex?.redact(params ?? {}, { threadId, turnId }) ?? params ?? {},
    }));
  }

  #emitItemMarkers(operation, item, { authoritative = false } = {}) {
    const protectedItem = this.privacyIndex?.redact(item, {
      threadId: operation.threadId, turnId: operation.nativeTurnId,
      itemId: item?.id ?? null, callId: item?.callId ?? item?.call_id ?? null,
    }) ?? item;
    for (const message of projectCodexItemMessages(protectedItem, {
      threadId: operation.threadId, turnId: operation.nativeTurnId,
      authoritative, kind: operation.kind,
    })) {
      const identities = operation.itemDisplayIdentities ??= new Map();
      const key = message.codexItemId;
      if (key && identities.has(key)) message.uuid = identities.get(key);
      else if (key) identities.set(key, message.uuid);
      if (message.isCompactSummary) {
        message.summarizeMetadata = { ...message.summarizeMetadata,
          timestamp: Date.now(), timestampSource: 'received' };
      }
      this.#emitOperationMarker(operation, '[MESSAGE] ' + JSON.stringify(message));
    }
  }

  #emitPlanMarker(operation, plan) {
    this.#emitOperationMarker(operation, `[MESSAGE] ${JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: `codex-plan-${operation.clientOperationId}`,
          name: 'todowrite',
          input: { plan: Array.isArray(plan) ? plan : [] },
        }],
      },
    })}`);
  }

  #upsertPlanItem(threadId, turnId, item, authoritative) {
    const itemId = item?.id ?? `plan-${Date.now()}`;
    const key = `${threadId ?? ''}:${itemId}`;
    const current = this.planItems.get(key) ?? {};
    const next = {
      ...current,
      ...(item ?? {}),
      id: itemId,
      threadId,
      turnId,
      type: 'plan',
      authoritative: authoritative || current.authoritative === true,
    };
    this.planItems.set(key, next);
    return next;
  }

  #handleEffectiveSettings(params) {
    const threadId = params?.threadId ?? null;
    const pending = this.pendingSettingsApplication;
    if (threadId && threadId !== (pending?.threadId ?? this.rootThreadId ?? this.desiredThreadId)) return;
    this.effectiveSettings = params?.threadSettings ?? params ?? {};
    if (this.pendingSettingsApplication) {
      if (this.settingsMatchesEffective(pending.settings)) {
        this.pendingSettingsApplication = null;
        pending.resolve(true);
      }
    }
    this.emit('codex_event', this.#envelope({
      kind: 'thread/settings/updated',
      threadId,
      payload: this.effectiveSettings,
    }));
  }

  // ==========================================================================
  // Stop semantics (D3)
  // ==========================================================================

  /**
   * Stop an operation in any dispatch phase. The confirmation budget is 10s
   * from cancelRequested and is never reset by late acks.
   */
  stopOperation(clientOperationId) {
    const operation = this.operations.get(clientOperationId);
    if (!operation) {
      // Already settled or unknown: nothing to stop.
      return { stopped: false, reason: 'unknown-or-settled' };
    }
    if (operation.cancelRequested) {
      return { stopped: true, reason: 'already-requested' };
    }
    operation.cancelRequested = true;
    operation.cancelRequestedAt = Date.now();
    if (operation.cancelTimer) {
      clearTimeout(operation.cancelTimer);
      operation.cancelTimer = null;
    }

    // Still queued (never dispatched): cancel locally with zero RPC, even if
    // another operation's bootstrap is in flight — this operation cannot have
    // written anything yet.
    const queuedIndex = this.queue.indexOf(operation);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.#settleOperation(operation, { outcome: 'cancelled', error: 'cancelled before write' });
      return { stopped: true, reason: 'cancelled-locally' };
    }

    // Active but not yet written, with an uncertain bootstrap in flight (its
    // own resume/start): keep the cancel intent for the dispatch gate.
    if (operation.dispatchPhase === 'notWritten' && this.bootstrapInFlight) {
      // Keep registered; dispatch will observe cancelRequested after bootstrap.
      this.#armUncertaintyWatch(operation);
      return { stopped: true, reason: 'waiting-for-bootstrap' };
    }

    // Active, not written, bootstrap settled: cancel locally, zero RPC.
    if (operation.dispatchPhase === 'notWritten') {
      if (this.activeOperationId === operation.clientOperationId) {
        this.activeOperationId = null;
        this.busy = false;
      }
      this.#settleOperation(operation, { outcome: 'cancelled', error: 'cancelled before write' });
      return { stopped: true, reason: 'cancelled-locally' };
    }

    // Native identity known: interrupt immediately.
    if (operation.nativeTurnId) {
      this.#interruptNativeTurn(operation);
      this.#armUncertaintyWatch(operation);
      return { stopped: true, reason: 'interrupted' };
    }

    // Written but identity unknown: keep the cancel intent; the identity
    // lookup binds and interrupts, or the budget terminates the runtime.
    this.#armUncertaintyWatch(operation);
    return { stopped: true, reason: 'cancel-intent-armed' };
  }

  /** Cancel a queued control operation before it writes any native RPC. */
  cancelPendingOperation(kind, threadId = null) {
    const index = this.queue.findIndex((operation) =>
      !operation.settled
      && operation.kind === kind
      && (threadId == null || operation.threadId === threadId));
    if (index < 0) {
      return { stopped: false, reason: 'no-pending-operation' };
    }
    const [operation] = this.queue.splice(index, 1);
    this.#settleOperation(operation, {
      outcome: 'cancelled',
      error: 'cancelled before dispatch',
    });
    this.#drainQueue();
    return { stopped: true, reason: 'cancelled-locally', clientOperationId: operation.clientOperationId };
  }

  #interruptNativeTurn(operation) {
    if (!operation.nativeTurnId || !this.client?.alive) {
      return;
    }
    this.client.request('turn/interrupt', {
      threadId: operation.threadId,
      turnId: operation.nativeTurnId,
    }, { timeoutMs: Math.max(1000, this.stopBudgetMs / 2) }).catch(() => {
      // Interrupt failures are reconciled by the uncertainty watch/terminal.
    });
  }

  // ==========================================================================
  // Settings revision gate (D8)
  // ==========================================================================

  /**
   * Record a desired-settings update. The response only queues the change;
   * effectiveness is confirmed by thread/settings/updated.
   */
  updateSettings(desired) {
    this.settingsRevision += 1;
    this.desiredSettings = { ...(this.desiredSettings || {}), ...desired, revision: this.settingsRevision };
    return { revision: this.settingsRevision, applied: false };
  }

  #freezeDesiredSettings() {
    return this.desiredSettings ? structuredClone(this.desiredSettings) : null;
  }

  /**
   * Serial settings application gate: one in-flight application at a time;
   * resolves true only when a matching effective notification arrived.
   */
  async #applyDesiredSettings(settings, threadId = this.rootThreadId ?? this.desiredThreadId) {
    if (!settings) {
      return true;
    }
    if (this.settingsMatchesEffective(settings)) {
      return true;
    }
    // Register the gate BEFORE writing so a thread/settings/updated
    // notification that races ahead of the ack still resolves it.
    let application;
    const effectiveGate = new Promise((resolvePromise) => {
      application = { resolve: resolvePromise, settings, threadId };
      this.pendingSettingsApplication = application;
    });
    const nativeSettings = toNativeThreadSettings(settings, threadId);
    try {
      await this.client.request('thread/settings/update', nativeSettings, { timeoutMs: 30_000 });
    } catch (err) {
      if (this.pendingSettingsApplication === application) this.pendingSettingsApplication = null;
      if (err?.code === 'RPC_TIMEOUT' && this.settingsMatchesEffective(settings)) return true;
      throw err;
    }
    let timer;
    const effective = await Promise.race([
      effectiveGate,
      new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), this.stopBudgetMs); }),
    ]);
    clearTimeout(timer);
    // A cancelled control's late reply must not clear its successor's confirmation gate.
    if (this.pendingSettingsApplication === application) this.pendingSettingsApplication = null;
    const confirmed = effective === true && this.settingsMatchesEffective(settings);
    return confirmed;
  }

  settingsMatchesEffective(settings) {
    if (!this.effectiveSettings || !settings) {
      return false;
    }
    // Compare the subset the plugin manages. The native notification exposes
    // sandboxPolicy while the UI stores the compact sandbox mode string.
    const collaborationMode = settings.collaborationMode ? structuredClone(settings.collaborationMode) : undefined;
    // Native null selects the mode's built-in instructions, whose echoed text is intentionally different.
    if (collaborationMode?.settings?.developer_instructions === null) {
      delete collaborationMode.settings.developer_instructions;
    }
    const expected = {
      model: settings.model,
      effort: settings.effort,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
      collaborationMode,
      cwd: settings.cwd,
      serviceTier: settings.serviceTier,
      sandboxPolicy: settings.sandboxPolicy
        ?? (settings.sandbox ? nativeSandboxPolicy(settings.sandbox) : undefined),
    };
    for (const [key, value] of Object.entries(expected)) {
      const actual = this.effectiveSettings[key];
      if (value !== undefined
          && !(key === 'serviceTier' ? normalizedServiceTier(actual) === normalizedServiceTier(value)
            : matchesManagedValues(actual, value))) {
        return false;
      }
    }
    return true;
  }

  // ==========================================================================
  // Reverse requests (interactions) — typed pass-through
  // ==========================================================================

  async #handleServerRequest(method, params, ctx) {
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
      'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(method)) {
      throw Object.assign(new Error(`unsupported server request: ${method}`), { code: -32601 });
    }
    // Verify the thread relation before surfacing: unknown threads are stored
    // as bounded metadata and verified with a short read-only query (D1).
    const threadId = params?.threadId;
    if (threadId && threadId !== this.rootThreadId && threadId !== this.desiredThreadId) {
      this.#recordThreadRelation(threadId);
      const verified = await this.#verifyThreadRelation(threadId);
      if (!verified) {
        // Cannot verify: refuse; never guess ownership or auto-accept (D1/D7).
        const err = new Error(`unverified thread relation for interaction: ${threadId}`);
        err.code = -32002;
        throw err;
      }
    }
    const requestParams = await this.#hydrateFileApprovalPreview(method, params);
    if (this.privacyIndex && (method.includes('requestUserInput') || method.includes('elicitation'))) {
      await this.privacyIndex.record({
        threadId,
        turnId: requestParams?.turnId ?? null,
        callId: requestParams?.callId ?? ctx.id,
        itemId: requestParams?.itemId ?? null,
        method,
        params: requestParams,
      });
    }
    if (this.client !== ctx.client || !ctx.client.alive || this.state === 'draining'
        || ctx.isPending && !ctx.isPending()) {
      return undefined;
    }
    if (method === 'item/commandExecution/requestApproval' && requestParams?.itemId
        && typeof requestParams.reason === 'string' && requestParams.reason.trim()) {
      const key = this.#itemSnapshotKey(threadId, requestParams.itemId);
      const item = this.itemSnapshots.get(key);
      // The approval reason belongs to this native item, never to the preceding
      // commentary or an unrelated command in the same turn.
      if (!item || item.type === 'commandExecution' && item.turnId === requestParams.turnId) {
        this.#rememberItemSnapshot(threadId, requestParams.turnId, { ...item,
          id: requestParams.itemId, type: 'commandExecution', approvalReason: requestParams.reason });
        const operation = this.#bindOperationByTurn(threadId, requestParams.turnId);
        if (operation && item?.command) this.#emitItemMarkers(operation, this.itemSnapshots.get(key));
      }
    }
    const thread = threadId ? this.threads.get(threadId) : null;
    this.pendingInteractions.set(ctx.id, {
      method,
      threadId,
      turnId: requestParams?.turnId ?? null,
    });
    this.emit('codex_event', this.#envelope({
      kind: 'interactionRequested',
      threadId: threadId ?? null,
      turnId: requestParams?.turnId ?? null,
      itemId: requestParams?.itemId ?? null,
      rootThreadId: thread?.rootThreadId ?? this.rootThreadId,
      payload: { method, params: requestParams, rpcId: ctx.id },
    }));
    // The reply is owned by the interaction registry (group 6/9); returning
    // undefined hands reply ownership to whoever consumes the event.
    return undefined;
  }

  #itemSnapshotKey(threadId, itemId) {
    return `${threadId ?? ''}:${itemId ?? ''}`;
  }

  #rememberItemSnapshot(threadId, turnId, item) {
    if (!threadId || !item || typeof item !== 'object' || !item.id) {
      return;
    }
    const key = this.#itemSnapshotKey(threadId, item.id);
    item = this.privacyIndex?.redact(item, { threadId, turnId, itemId: item.id }) ?? item;
    const stored = this.itemSnapshots.get(key);
    const previous = stored && (!stored.turnId || !turnId || stored.turnId === turnId) ? stored : {};
    const snapshot = {
      ...previous,
      ...item,
      type: item.type ?? item.itemType ?? previous.type ?? previous.itemType,
      threadId,
      turnId: turnId ?? item.turnId ?? previous.turnId ?? null,
    };
    if (snapshot.type === 'reasoning') {
      // Native summary deltas can carry plaintext that is absent from the completed item.
      for (const field of ['summary', 'content']) {
        if (Array.isArray(item[field]) && item[field].length === 0 && Array.isArray(previous[field])
            && previous[field].some(entry => typeof entry === 'string' ? entry.length > 0
              : typeof entry?.text === 'string' && entry.text.length > 0)) {
          snapshot[field] = previous[field];
        }
      }
    }
    if (['agentMessage', 'agent_message'].includes(item.type ?? item.itemType ?? previous.type ?? previous.itemType)) {
      // Native versions use either text or content. A stale empty representation
      // must not shadow the newly received body, including authoritative empties.
      if (typeof item.text === 'string' && !Object.hasOwn(item, 'content')) delete snapshot.content;
      if (Array.isArray(item.content) && !Object.hasOwn(item, 'text')) delete snapshot.text;
    }
    this.itemSnapshots.set(key, snapshot);
  }

  #fileChangePreview(item) {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const changes = item.proposedChanges ?? item.proposed_changes
      ?? item.changes ?? item.fileChanges ?? item.files;
    if (Array.isArray(changes) && changes.length > 0) {
      return normalizeFileChanges(changes);
    }
    if (changes && typeof changes === 'object' && Object.keys(changes).length > 0) {
      return normalizeFileChanges(changes);
    }
    return null;
  }

  async #hydrateFileApprovalPreview(method, params) {
    if (method !== 'item/fileChange/requestApproval' || !params?.threadId || !params?.itemId) {
      return params;
    }
    const itemKey = this.#itemSnapshotKey(params.threadId, params.itemId);
    let item = this.itemSnapshots.get(itemKey) ?? null;
    let preview = this.#fileChangePreview(item);
    if (!preview) {
      try {
        let cursor = null;
        const seen = new Set();
        const deadline = Date.now() + 2_000;
        do {
          const response = await this.client.request('thread/items/list', {
            threadId: params.threadId, turnId: params.turnId ?? null,
            cursor, limit: 100, sortDirection: 'desc',
          }, { timeoutMs: Math.max(1, deadline - Date.now()) });
          const entries = Array.isArray(response?.data) ? response.data : response?.items ?? [];
          item = entries.filter((entry) => !entry.turnId || !params.turnId || entry.turnId === params.turnId)
            .map((entry) => entry.item ?? entry).find((candidate) => candidate?.id === params.itemId) ?? null;
          cursor = response.nextCursor ?? null;
          if (cursor != null && seen.has(cursor)) break;
          seen.add(cursor);
        } while (!item && cursor != null && seen.size < 5 && Date.now() < deadline);
        this.#rememberItemSnapshot(params.threadId, params.turnId, item);
        preview = this.#fileChangePreview(item);
      } catch {
        // A missing or unavailable preview must keep the approval deny-only.
        preview = null;
      }
    }
    return preview ? { ...params, proposedChanges: preview } : params;
  }

  async #verifyThreadRelation(threadId) {
    try {
      const client = this.client;
      const root = this.rootThreadId ?? this.desiredThreadId;
      if (!root || !client?.alive) return false;
      const deadline = Date.now() + 5000;
      const seen = new Set();
      const ancestry = [];
      let current = threadId;
      // A leaf read proves only its immediate parent, not the whole relation.
      while (current !== root) {
        if (!current || seen.has(current) || seen.size >= 32 || Date.now() >= deadline) return false;
        seen.add(current);
        const response = await client.request('thread/read', { threadId: current },
          { timeoutMs: Math.max(1, deadline - Date.now()) });
        if (this.client !== client || !client.alive || this.state === 'draining') return false;
        const nativeThread = response?.thread;
        if (nativeThread?.id !== current || !nativeThread.parentThreadId) return false;
        ancestry.push(nativeThread);
        current = nativeThread.parentThreadId;
      }
      if (root !== (this.rootThreadId ?? this.desiredThreadId)) return false;
      for (const nativeThread of ancestry.reverse()) {
        const thread = this.#recordThreadRelation(nativeThread.id, nativeThread.parentThreadId);
        if (this.#rootOf(nativeThread.id) !== root) return false;
        thread.relationVerified = true;
        if (thread.state === 'unloaded') {
          thread.state = 'idle';
        }
        this.emit('codex_event', this.#envelope({ kind: 'threadRelationVerified', threadId: nativeThread.id,
          payload: { parentThreadId: thread.parentThreadId } }));
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Reply to a verified interaction (bypasses the FIFO entirely, D4). */
  respondInteraction(rpcId, result) {
    const interaction = this.pendingInteractions.get(rpcId);
    if (!interaction || !this.client?.alive) return false;
    const validation = validateInteractionResult(interaction?.method, result);
    if (!validation.valid) {
      // Local validation leaves the native request pending for one corrected answer.
      return false;
    }
    this.client.replyServerRequest(rpcId, validation.result);
    this.pendingInteractions.delete(rpcId);
    return true;
  }

  /** Typed error reply for a verified interaction. */
  respondInteractionError(rpcId, code, message) {
    if (!this.pendingInteractions.has(rpcId) || !this.client?.alive) return false;
    this.client?.replyServerError(rpcId, code, message);
    this.pendingInteractions.delete(rpcId);
    return true;
  }

  // ==========================================================================
  // Public entry points
  // ==========================================================================

  /**
   * Connect (or reuse) the runtime and ensure the given thread is loaded.
   * Never starts a turn.
   */
  async preconnect({ threadId = null, launchOptions = null } = {}) {
    if (launchOptions && this.launchOptions !== launchOptions) {
      this.launchOptions = launchOptions;
    }
    await this.ensureRuntime();
    if (threadId) {
      this.desiredThreadId = threadId;
      this.#recordThreadRelation(threadId);
      if (!this.rootThreadId) {
        this.rootThreadId = threadId;
      }
      if (!this.#isThreadLoaded(threadId)) {
        await this.#resumeThread(threadId);
      }
    }
    return { runtimeGeneration: this.runtimeGeneration, state: this.state };
  }

  /**
   * Execute a read-only native app-server request without occupying the
   * send/compact/review FIFO. The caller chooses a protocol method from the
   * app-server read-only surface and receives the unmodified response.
   */
  async readOnly(method, params = {}) {
    const allowed = new Set([
      'thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list',
      'model/list', 'skills/list', 'mcpServerStatus/list', 'config/mcpServer/reload',
    ]);
    if (!allowed.has(method)) {
      throw new ClassifiedError('UNSUPPORTED', `unsupported Codex read-only method: ${method}`);
    }
    await this.ensureRuntime();
    const response = await this.client.request(method, params, { timeoutMs: 30_000 });
    if (this.privacyIndex?.load) await this.privacyIndex.load();
    return method.startsWith('thread/') ? this.#redactNativeProjection(response, params) : response;
  }

  /** Save a name on the owned native root without opening or resuming another writer. */
  async setThreadName(threadId, name) {
    if (!this.client?.alive || !threadId || threadId !== this.rootThreadId) {
      throw new ClassifiedError('STALE_THREAD', 'The Codex thread is no longer active');
    }
    const client = this.client;
    await client.request('thread/name/set', { threadId, name }, { timeoutMs: 15_000 });
    if (this.client === client && this.rootThreadId === threadId) {
      const thread = this.threads.get(threadId);
      if (thread) thread.name = name;
      this.emit('codex_event', this.#envelope({ kind: 'threadNameUpdated', threadId,
        payload: { threadName: name } }));
    }
    return true;
  }

  #redactNativeProjection(value, inheritedIdentity = {}) {
    if (!this.privacyIndex || !value || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.#redactNativeProjection(entry, inheritedIdentity));
    }
    const identity = {
      ...inheritedIdentity,
      threadId: value.threadId ?? value.thread_id ?? inheritedIdentity.threadId ?? null,
      turnId: value.turnId ?? value.turn_id ?? inheritedIdentity.turnId ?? null,
      itemId: value.itemId ?? value.item_id ?? value.id ?? inheritedIdentity.itemId ?? null,
      callId: value.callId ?? value.call_id ?? inheritedIdentity.callId ?? null,
    };
    return this.privacyIndex.redact(value, identity);
  }

  /**
   * Send a user message. `input` uses native UserInput items; settings are
   * frozen at enqueue time (D8). Resolves at the native terminal exactly once.
   */
  async send({ threadId = null, input = [], clientMessageId = null, settings = undefined }) {
    const operation = this.enqueueOperation({
      kind: 'send',
      threadId,
      clientMessageId,
      settings,
      markerPayload: { input },
    });
    return await operation.promise;
  }

  /** Manual compact (D9): FIFO-queued, native operation, no model prompt. */
  async compact({ threadId = null, settings = undefined } = {}) {
    const targetThreadId = threadId ?? this.rootThreadId;
    if (!targetThreadId) {
      throw new ClassifiedError('NO_THREAD', 'Start a Codex conversation before compacting it');
    }
    const operation = this.enqueueOperation({ kind: 'compact', threadId: targetThreadId, settings });
    return await operation.promise;
  }

  /** Native inline review of uncommitted changes (D9). */
  async review({ threadId = null, settings = undefined } = {}) {
    const targetThreadId = threadId ?? this.rootThreadId;
    if (!targetThreadId) {
      throw new ClassifiedError('NO_THREAD', 'Start a Codex conversation before reviewing it');
    }
    const operation = this.enqueueOperation({ kind: 'review', threadId: targetThreadId, settings });
    return await operation.promise;
  }

  /**
   * Release a thread and drain its relation set (D1): pending operations are
   * cancelled, descendants unloaded, and the lease freed after confirmation.
   */
  async releaseThread(threadId = null) {
    const target = threadId ?? this.rootThreadId;
    this.#setState('draining');
    try {
      for (const [rpcId, interaction] of [...this.pendingInteractions.entries()]) {
        const root = interaction.threadId ? this.#rootOf(interaction.threadId) : null;
        if (!target || interaction.threadId === target || root === target) {
          this.respondInteractionError(rpcId, -32001, 'Codex thread was released');
        }
      }
      for (const operation of [...this.operations.values()]) {
        const root = operation.threadId ? this.#rootOf(operation.threadId) : null;
        if (!target || root === target || operation.threadId === target) {
          if (!operation.settled) {
            this.stopOperation(operation.clientOperationId);
          }
        }
      }
      const draining = [...this.operations.values()].filter((operation) => !target
        || operation.threadId === target || this.#rootOf(operation.threadId) === target);
      await Promise.all(draining.map((operation) => operation.promise));
      for (const thread of [...this.threads.values()]) {
        if (!target || thread.threadId === target || this.#rootOf(thread.threadId) === target) {
          thread.state = 'unloaded';
        }
      }
      if (this.rootThreadId === target) {
        this.rootThreadId = null;
      }
      if (this.desiredThreadId === target) {
        this.desiredThreadId = null;
      }
      this.planItems.clear();
      this.itemSnapshots.clear();
    } finally {
      await this.resetRuntime({ reason: 'thread-released' });
      // resetRuntime always ends with the client detached, so the runtime is
      // stopped here; the next operation cold-starts it on demand.
      this.#setState('stopped');
    }
    return { released: target };
  }

  /**
   * Tear the runtime down: drain operations, close the child, confirm exit.
   */
  async resetRuntime({ reason = 'reset', failure = null } = {}) {
    if (this.runtimeResetPromise) return this.runtimeResetPromise;
    // Bypassing controls can share one retiring writer; only its owner may detach it.
    const resetting = this.#retireRuntime({ reason, failure });
    this.runtimeResetPromise = resetting;
    try {
      await resetting;
    } finally {
      if (this.runtimeResetPromise === resetting) this.runtimeResetPromise = null;
      this.#drainQueue();
    }
  }

  async #retireRuntime({ reason, failure }) {
    this.#setState('draining');
    const retiringOperations = [...this.operations.values()];
    for (const operation of retiringOperations) {
      if (!operation.settled && !failure) {
        this.stopOperation(operation.clientOperationId);
      }
    }
    const client = this.client;
    if (client) {
      client.close();
      await client.waitForExit();
    }
    for (const operation of retiringOperations) {
      this.#settleOperation(operation, { outcome: operation.cancelRequested ? 'cancelled' : 'failed',
        error: failure ?? `runtime reset: ${reason}` });
    }
    this.queue = this.queue.filter((operation) => !operation.settled);
    this.pendingInteractions.clear();
    this.pendingSettingsApplication?.resolve(false);
    this.pendingSettingsApplication = null;
    this.effectiveSettings = null;
    this.client = null;
    this.threadResumes.clear();
    // The new child owns no loaded threads; ids survive for cold resume.
    for (const thread of this.threads.values()) {
      thread.state = 'unloaded';
    }
    this.itemSnapshots.clear();
    this.planItems.clear();
    this.busy = false;
    this.activeOperationId = null;
    this.#setState('stopped');
    this.emit('codex_event', this.#envelope({ kind: 'runtimeReset', payload: { reason } }));
  }

  /** Snapshot for daemon runtime status. */
  snapshot() {
    return {
      state: this.state,
      runtimeGeneration: this.runtimeGeneration,
      runtimePid: this.client?.child?.pid > 0 ? this.client.child.pid : null,
      rootThreadId: this.rootThreadId,
      busy: this.busy,
      activeOperationId: this.activeOperationId,
      queueLength: this.queue.length,
      threads: [...this.threads.values()].map((thread) => ({
        threadId: thread.threadId,
        parentThreadId: thread.parentThreadId,
        rootThreadId: thread.rootThreadId,
        state: thread.state,
        relationVerified: thread.relationVerified,
      })),
      settingsRevision: this.settingsRevision,
      effectiveSettings: this.effectiveSettings,
      planItems: [...this.planItems.values()].map((item) => ({ ...item })),
    };
  }
}

function summarizeNotification(params) {
  try {
    const json = JSON.stringify(params ?? {});
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return '(unserializable)';
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return {};
  }
  return {
    input_tokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.outputTokens ?? 0,
    cached_input_tokens: usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens
      ?? usage.cacheReadInputTokens
      ?? usage.cached_input_tokens
      ?? usage.cachedInputTokens
      ?? 0,
  };
}

function matchesManagedValues(actual, expected) {
  if (!expected || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length
      && expected.every((value, index) => matchesManagedValues(actual[index], value));
  }
  return actual && typeof actual === 'object' && Object.entries(expected)
    .every(([key, value]) => matchesManagedValues(actual[key], value));
}

function normalizedServiceTier(tier) {
  // Native snapshots echo these two request values as their explicit routing sentinels.
  return tier === 'fast' ? 'priority' : tier === null ? 'default' : tier;
}

function subtractUsage(total, baseline) {
  return Object.fromEntries(Object.entries(total).map(([key, value]) => [key,
    Math.max(0, value - (baseline?.[key] ?? 0)),
  ]));
}

/** Normalize native file changes while preserving add/delete/rename semantics. */
function normalizeFileChanges(changes) {
  if (Array.isArray(changes)) {
    return changes.map((change) => ({ ...change }));
  }
  if (!changes || typeof changes !== 'object') {
    return [];
  }
  return Object.entries(changes).map(([path, change]) => ({
    ...(change && typeof change === 'object' ? change : { diff: change }),
    path: change?.path ?? path,
  }));
}

/**
 * Convert plugin settings into the strict thread/settings/update contract.
 * Internal revision metadata and UI-only developerInstructions are never sent
 * as unknown top-level protocol fields.
 */
function toNativeThreadSettings(settings, threadId) {
  if (!threadId) {
    throw new ClassifiedError('NO_THREAD', 'thread/settings/update requires a thread id');
  }
  const native = { threadId };
  for (const key of [
    'model', 'effort', 'serviceTier', 'approvalPolicy', 'approvalsReviewer', 'collaborationMode', 'cwd',
  ]) {
    if (settings[key] !== undefined) {
      native[key] = settings[key];
    }
  }
  if (settings.sandboxPolicy !== undefined) {
    native.sandboxPolicy = settings.sandboxPolicy;
  } else if (settings.sandbox !== undefined) {
    native.sandboxPolicy = nativeSandboxPolicy(settings.sandbox);
  }
  return native;
}

function nativeSandboxPolicy(mode) {
  if (mode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }
  if (mode === 'read-only') {
    return { type: 'readOnly', networkAccess: false };
  }
  return {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function validateInteractionResult(method, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { valid: false, error: 'interaction result must be an object' };
  }
  if (!method) {
    return { valid: true, result };
  }
  if (method === 'item/tool/requestUserInput') {
    const answers = result.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return { valid: false, error: 'user input response requires an answers object' };
    }
    if (!Object.values(answers).every((answer) => answer && typeof answer === 'object'
        && Array.isArray(answer.answers) && answer.answers.every((value) => typeof value === 'string'))) {
      return { valid: false, error: 'each user input answer requires a string array' };
    }
    return { valid: true, result: { answers } };
  }
  if (method === 'mcpServer/elicitation/request') {
    if (!['accept', 'decline', 'cancel'].includes(result.action)) {
      return { valid: false, error: 'elicitation action must be accept, decline, or cancel' };
    }
    if (result.action !== 'accept' && result.content !== undefined && result.content !== null) {
      return { valid: false, error: 'declined elicitation cannot include content' };
    }
    if (result.action === 'accept' && result.content !== undefined && result.content !== null
        && (typeof result.content !== 'object' || Array.isArray(result.content))) {
      return { valid: false, error: 'accepted elicitation content must be an object or null' };
    }
    if (result._meta !== undefined && result._meta !== null
        && (typeof result._meta !== 'object' || Array.isArray(result._meta))) {
      return { valid: false, error: 'elicitation _meta must be an object or null' };
    }
    const response = { action: result.action };
    if (result.content !== undefined) response.content = result.content;
    if (result._meta !== undefined) response._meta = result._meta;
    return { valid: true, result: response };
  }
  if (method === 'item/commandExecution/requestApproval'
      || method === 'item/fileChange/requestApproval') {
    const decision = result.decision;
    const allowed = ['accept', 'acceptForSession', 'decline', 'cancel'];
    if (allowed.includes(decision)) {
      return { valid: true, result: { decision } };
    }
    if (method.includes('commandExecution') && decision && typeof decision === 'object'
        && !Array.isArray(decision)) {
      const amendment = decision.acceptWithExecpolicyAmendment;
      if (amendment && typeof amendment === 'object' && !Array.isArray(amendment)
          && Array.isArray(amendment.execpolicy_amendment)
          && amendment.execpolicy_amendment.every((entry) => typeof entry === 'string')) {
        return { valid: true, result: { decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: [...amendment.execpolicy_amendment],
          },
        } } };
      }
      const network = decision.applyNetworkPolicyAmendment;
      const rule = network?.network_policy_amendment;
      if (network && typeof network === 'object' && rule && typeof rule === 'object'
          && !Array.isArray(rule) && typeof rule.host === 'string'
          && (rule.action === 'allow' || rule.action === 'deny')) {
        return { valid: true, result: { decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: {
              host: rule.host,
              action: rule.action,
            },
          },
        } } };
      }
    }
    if (!allowed.includes(decision)) {
      return { valid: false, error: 'approval decision is unsupported' };
    }
  }
  if (method === 'item/permissions/requestApproval') {
    if (!result.permissions || typeof result.permissions !== 'object'
        || Array.isArray(result.permissions)) {
      return { valid: false, error: 'permission approval requires a permissions profile' };
    }
    if (result.scope !== undefined && result.scope !== 'turn' && result.scope !== 'session') {
      return { valid: false, error: 'permission approval scope must be turn or session' };
    }
    return {
      valid: true,
      result: {
        permissions: result.permissions,
        ...(result.scope ? { scope: result.scope } : {}),
      },
    };
  }
  return { valid: true, result };
}
