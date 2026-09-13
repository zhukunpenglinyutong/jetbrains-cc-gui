/**
 * Grok ACP (Agent Client Protocol) JSON-RPC client over `grok agent stdio`.
 *
 * Protocol (docs.x.ai headless scripting):
 *   initialize → authenticate → session/new|load → session/prompt
 *   assistant text arrives as session/update notifications (agent_message_chunk)
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  resolveGrokBinary,
  selectGrokAuthMethodId,
  normalizeAuthMethod,
  applyGrokBaseUrlEnv,
  resolveEffectiveGrokAuth,
  normalizeGrokModelId,
} from './grok-utils.js';
import { requestPermissionFromJava } from '../../permission-ipc.js';
import { AcpTerminalHost, isTerminalMethod } from './acp-terminal-host.js';
import {
  buildGrokImageBlocks,
  GROK_IMAGE_ONLY_FALLBACK_TEXT,
} from '../../utils/cli-image-input.js';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * User-turn session/prompt budget. Long agentic runs (tools + terminal) routinely
 * exceed 5 minutes; 300s was killing healthy turns with ACP timeout.
 * Override: GROK_ACP_TURN_TIMEOUT_MS (clamped 5m … 4h).
 */
const DEFAULT_TURN_PROMPT_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const MIN_TURN_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TURN_PROMPT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export function resolveTurnPromptTimeoutMs(env = process.env) {
  const raw = env?.GROK_ACP_TURN_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') {
    return DEFAULT_TURN_PROMPT_TIMEOUT_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_TURN_PROMPT_TIMEOUT_MS;
  }
  return Math.min(MAX_TURN_PROMPT_TIMEOUT_MS, Math.max(MIN_TURN_PROMPT_TIMEOUT_MS, Math.floor(n)));
}

export const TURN_PROMPT_TIMEOUT_MS = resolveTurnPromptTimeoutMs();

/**
 * Reusable helpers for both one-shot (runAcpTurn) and persistent runtime paths.
 * These allow init+auth+session to be done once, then prompt() reused.
 */

export async function initializeAndAuthenticate(client, { apiKey = '', baseUrl = '', hasApiKeyFromEnv = false, authMethod = '' } = {}) {
  const init = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      // Terminal host wired; see acp-terminal-host.js
      terminal: true,
    },
    clientInfo: {
      name: 'codemoss-jetbrains',
      version: '0.4.6',
    },
  });

  const authMethodList = init.authMethods ?? [];
  const authMethods = new Set(authMethodList.map((m) => m.id));
  const defaultAuth = init._meta?.defaultAuthMethodId || null;

  // Safety net: OAuth with empty auth.json → config.toml / plugin api_key.
  // Callers usually resolve first; this covers one-shot / partial env paths.
  const resolved = resolveEffectiveGrokAuth({
    preferredAuth: authMethod || process.env.GROK_AUTH_METHOD || '',
    apiKey,
    baseUrl,
  });
  const preferred = normalizeAuthMethod(resolved.authMethod) || 'oauth';
  const effectiveKey = resolved.apiKey || apiKey || '';
  const hasApiKey =
    preferred === 'oauth'
      ? false
      : !!(hasApiKeyFromEnv || effectiveKey);

  let methodId = selectGrokAuthMethodId({
    authMethods,
    defaultAuth,
    preferred,
    hasApiKey,
  });

  if (!methodId) {
    throw new Error(
      preferred === 'api_key'
        ? 'No Grok API key auth available. Set XAI_API_KEY in Settings → Grok (or env), or switch Auth to OAuth and run `grok login`.'
        : 'No Grok auth available. Run `grok login` (OAuth for SuperGrok/Heavy), or set Auth to API Key with a valid XAI_API_KEY.'
    );
  }

  console.error(
    '[GROK-ACP] authenticate methodId=' +
      methodId +
      ' preferred=' +
      preferred +
      ' hasApiKey=' +
      hasApiKey +
      ' authReason=' +
      resolved.reason
  );

  await client.request('authenticate', {
    methodId,
    _meta: { headless: true },
  });

  client.initResult = init;
  return { init, methodId, resolvedAuth: resolved };
}

export async function ensureSession(client, { sessionId = '', cwd = '', model = '' } = {}) {
  const workCwd = cwd && cwd.trim() ? cwd.trim() : process.cwd();
  let activeSessionId = sessionId && String(sessionId).trim() ? String(sessionId).trim() : '';
  let sessionMeta = null;

  const canLoad = !!activeSessionId && client && true; // assume capability check if exposed

  if (activeSessionId && (client?.initResult?.agentCapabilities?.loadSession ?? true)) {
    try {
      sessionMeta = await client.request('session/load', {
        sessionId: activeSessionId,
        cwd: workCwd,
        mcpServers: [],
      });
    } catch (e) {
      // fall through to new
      activeSessionId = '';
    }
  }

  const effectiveModel = normalizeGrokModelId(model);

  if (!activeSessionId) {
    const newParams = {
      cwd: workCwd,
      mcpServers: [],
    };
    if (effectiveModel) {
      newParams._meta = { ...(newParams._meta || {}), modelId: effectiveModel };
    }
    sessionMeta = await client.request('session/new', newParams);
    activeSessionId = sessionMeta.sessionId || sessionMeta.session?.sessionId || '';
  }

  if (!activeSessionId) {
    throw new Error('ACP session/new did not return sessionId');
  }

  client.activeSessionId = activeSessionId;

  // Best-effort model set
  if (effectiveModel) {
    try {
      await client.request('session/set_model', {
        sessionId: activeSessionId,
        modelId: effectiveModel,
      });
    } catch {
      // optional
    }
  }

  return { sessionId: activeSessionId, sessionMeta };
}

/**
 * Sync Grok CLI always-approve flag with our permission mode.
 * Default/plan/acceptEdits must turn always-approve OFF so ACP keeps
 * emitting session/request_permission (otherwise tools run in silence).
 * Bypass/auto modes turn it ON.
 *
 * This is the single entry point for mode→CLI sync (replaces the old
 * applyAutoApproveIfNeeded helper that only ever turned always-approve on).
 */
/**
 * Control-plane prompts (/always-approve on|off) should not wait the full turn
 * timeout. They are best-effort and must never kill a healthy mid-turn agent:
 * recycleOnTimeout is false so a slow/busy session only skips the mode sync
 * (error swallowed) instead of popping ACP timeout UI or recycling the runtime.
 */
const PERMISSION_MODE_SYNC_TIMEOUT_MS = 20_000;

export async function applyPermissionModeToSession(client, sessionId, permissionMode) {
  if (!client || !sessionId) return;
  const cmd = isAutoApproveMode(permissionMode) ? '/always-approve on' : '/always-approve off';
  try {
    await client.request(
      'session/prompt',
      {
        sessionId,
        prompt: [{ type: 'text', text: cmd }],
      },
      PERMISSION_MODE_SYNC_TIMEOUT_MS,
      { recycleOnTimeout: false },
    );
  } catch {
    // Best-effort: older CLIs may not support the command, or the agent is busy
    // on a user turn. Never surface to UI; live.permissionMode still drives dialogs.
  }
}

export class GrokAcpClient {
  constructor({
    env = process.env,
    cwd = process.cwd(),
    onNotification,
    onServerRequest,
    onFsWrite = null,
    onStderr,
    terminalHost = null,
  } = {}) {
    this.env = env;
    this.cwd = cwd || process.cwd();
    this.onNotification = onNotification || (() => {});
    this.onServerRequest = onServerRequest || null;
    /** After successful ACP host fs/write_text_file — for edit-stats ledger. */
    this.onFsWrite = typeof onFsWrite === 'function' ? onFsWrite : null;
    this.onStderr = onStderr || (() => {});
    this.terminalHost = terminalHost;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.stderrBuf = '';
  }

  getLastStderr() {
    return this.stderrBuf.slice(-4000);
  }

  start() {
    if (this.proc) return;

    const bin = resolveGrokBinary();
    this.proc = spawn(bin, ['agent', 'stdio'], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.activeSessionId = null;
    this.initResult = null;
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this.#handleLine(line));

    this.proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      this.stderrBuf = (this.stderrBuf + s).slice(-8000);
      try {
        this.onStderr(s);
      } catch {
        // ignore listener errors
      }
    });

    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      const err = new Error(`grok agent stdio exited (code=${code}, signal=${signal || 'none'})`);
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });

    this.proc.on('error', (err) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @param {{ recycleOnTimeout?: boolean }} [options]
   *   recycleOnTimeout (default true): on timeout, mark unhealthy + kill process
   *   so the next user turn recovers. Set false for best-effort control prompts
   *   (/always-approve) that must not abort an in-flight user turn.
   */
  async request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
    if (!this.proc || this.closed) {
      throw new Error('ACP client is not running');
    }
    const recycleOnTimeout = options.recycleOnTimeout !== false;
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`ACP timeout waiting for ${method}`);
        err.code = 'ACP_TIMEOUT';
        err.method = method;
        this.pending.delete(id);
        if (recycleOnTimeout) {
          // Abandoning a user-turn RPC leaves the agent busy → recycle.
          this.markUnhealthy(err.message, { killProcess: true });
        }
        // Soft timeout: leave client alive (control-plane /always-approve).
        reject(err);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  /**
   * Mark this client unusable for further turns.
   * After an ACP timeout (or similar stream corruption), the daemon must dispose
   * the runtime and create a fresh agent — otherwise session/prompt never recovers.
   */
  markUnhealthy(reason = 'ACP client unhealthy', { killProcess = false } = {}) {
    this.unhealthy = true;
    this.unhealthyReason = reason;
    this.closed = true;

    const err = new Error(reason);
    err.code = 'ACP_UNHEALTHY';
    for (const [, p] of this.pending) {
      try {
        p.reject(err);
      } catch {
        // ignore double-reject
      }
    }
    this.pending.clear();

    if (killProcess && this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      // Best-effort SIGKILL after a short grace (fire-and-forget; close() also kills).
      const proc = this.proc;
      setTimeout(() => {
        try {
          if (proc && proc.exitCode === null) proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 300).unref?.();
    }
  }

  /** True when a prior timeout/corruption requires runtime recycle. */
  isUnhealthy() {
    return !!(this.unhealthy || this.closed);
  }

  respond(id, result) {
    if (!this.proc || this.closed) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  respondError(id, code, message) {
    if (!this.proc || this.closed) return;
    this.proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code, message },
      }) + '\n'
    );
  }

  async close() {
    this.closed = true;
    try {
      if (this.terminalHost) {
        await this.terminalHost.disposeAll();
      }
    } catch {
      // ignore terminal cleanup errors
    }
    try {
      this.rl?.close();
    } catch {
      // ignore
    }
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      // Force kill if still alive after a short grace period
      await new Promise((r) => setTimeout(r, 300));
      if (this.proc && this.proc.exitCode === null) {
        try {
          this.proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    this.proc = null;
    this.activeSessionId = null;
  }

  /**
   * Perform a prompt on an already-initialized/authenticated session.
   * Client must be started and session active.
   * Default timeout is long (see TURN_PROMPT_TIMEOUT_MS / GROK_ACP_TURN_TIMEOUT_MS).
   */
  async prompt(sessionId, promptBlocks, timeoutMs = TURN_PROMPT_TIMEOUT_MS) {
    if (!this.proc || this.closed) {
      throw new Error('ACP client is not running');
    }
    const sid = sessionId || this.activeSessionId;
    if (!sid) {
      throw new Error('No sessionId available for prompt');
    }
    const result = await this.request(
      'session/prompt',
      { sessionId: sid, prompt: promptBlocks },
      timeoutMs
    );
    this.activeSessionId = sid;
    return result;
  }

  /**
   * Abort any in-flight request(s) and mark closed for this turn.
   * Does not fully close the underlying process (caller decides whether to recycle client).
   */
  abortActiveRequests(reason = 'aborted') {
    const err = new Error(reason);
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  #handleLine(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Non-JSON noise on stdout corrupts ACP; surface for debugging
      this.onStderr(`[ACP non-json stdout] ${trimmed.slice(0, 300)}\n`);
      return;
    }

    // Notifications (no id)
    if (message.method && message.id == null) {
      this.onNotification(message.method, message.params || {});
      return;
    }

    // Server → client request (method + id, no result/error)
    if (
      message.method &&
      message.id != null &&
      message.result === undefined &&
      message.error === undefined
    ) {
      this.#handleServerRequest(message);
      return;
    }

    // Response to our request
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        let msg = message.error.message || JSON.stringify(message.error);
        if (/^Internal error/i.test(msg) && this.stderrBuf) {
          // Prefer concrete API error from agent stderr (credits/auth/etc.)
          const detail = this.stderrBuf
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /error_message=|permission-denied|403|credits|licenses|API error/i.test(l))
            .slice(-3)
            .join('\n');
          if (detail) {
            msg = `${msg}\n\n${detail}`;
          } else {
            msg = `${msg}\n\n${this.getLastStderr().slice(-800)}`;
          }
        }
        const err = new Error(msg);
        err.code = message.error.code;
        err.data = message.error.data;
        err.raw = message.error;
        err.stderr = this.getLastStderr();
        pending.reject(err);
      } else {
        pending.resolve(message.result ?? {});
      }
    }
  }

  #handleServerRequest(message) {
    const method = message.method;
    const params = message.params || {};
    const id = message.id;

    // Built-in filesystem helpers (required by clientCapabilities we advertise)
    if (method === 'fs/read_text_file' || method === 'fs/readTextFile') {
      try {
        const filePath = params.path;
        if (!filePath) {
          this.respondError(id, -32602, 'path is required');
          return;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        this.respond(id, { content });
      } catch (e) {
        this.respondError(id, -32000, e.message || String(e));
      }
      return;
    }

    if (method === 'fs/write_text_file' || method === 'fs/writeTextFile') {
      try {
        const filePath = params.path;
        const content = params.content ?? '';
        if (!filePath) {
          this.respondError(id, -32602, 'path is required');
          return;
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
        this.respond(id, {});
        try {
          this.onFsWrite?.({
            path: filePath,
            content: typeof content === 'string' ? content : String(content ?? ''),
          });
        } catch {
          // never fail the write because stats bookkeeping failed
        }
      } catch (e) {
        this.respondError(id, -32000, e.message || String(e));
      }
      return;
    }

    // ACP terminal host (clientCapabilities.terminal === true)
    if (this.terminalHost && isTerminalMethod(method)) {
      Promise.resolve(this.terminalHost.handle(method, params))
        .then((result) => {
          this.respond(id, result ?? {});
        })
        .catch((e) => {
          const code = typeof e?.code === 'number' ? e.code : -32000;
          this.respondError(id, code, e?.message || String(e));
        });
      return;
    }

    // Custom handler (permissions, etc.)
    if (typeof this.onServerRequest === 'function') {
      Promise.resolve(this.onServerRequest(method, params, id, this))
        .then((handled) => {
          if (!handled) {
            // Default: empty success so agent can continue in YOLO-like modes
            this.respond(id, { outcome: { outcome: 'selected', optionId: 'allow' } });
          }
        })
        .catch((e) => {
          this.respondError(id, -32000, e.message || String(e));
        });
      return;
    }

    // Default allow-ish response for unknown requests
    this.respond(id, { outcome: { outcome: 'selected', optionId: 'allow' } });
  }
}

/**
 * High-level: one-shot turn over ACP, then close process.
 * Emits structured events via callbacks for the normalizer.
 */
export async function runAcpTurn({
  authMethod = '',
  message,
  sessionId = '',
  cwd = '',
  model = '',
  apiKey = '',
  baseUrl = '',
  permissionMode = '',
  agentPrompt = '',
  openedFiles = null,
  attachments = [],
  env: baseEnv = process.env,
  onEvent,
  onStderr,
}) {
  // Until the real user session/prompt starts, suppress stream-like events.
  // session/load and /always-approve can re-emit prior-turn thought/text chunks;
  // if those land after [STREAM_START] the UI paints the previous answer under
  // the new user bubble (multi-turn duplicate render).
  let liveStreaming = false;
  const PRE_PROMPT_EVENTS = new Set([
    'session_id',
    'prompt_phase_start',
    'initialized',
    'authenticated',
    'session_new',
  ]);
  const emit = (type, payload) => {
    if (!liveStreaming && !PRE_PROMPT_EVENTS.has(type)) {
      return;
    }
    if (typeof onEvent === 'function') onEvent(type, payload);
  };

  const resolvedAuth = resolveEffectiveGrokAuth({
    preferredAuth: authMethod || baseEnv.GROK_AUTH_METHOD || process.env.GROK_AUTH_METHOD || '',
    apiKey,
    baseUrl,
  });
  const effectiveAuthMethod = resolvedAuth.authMethod;
  const effectiveApiKey = resolvedAuth.apiKey;
  const effectiveBaseUrl = resolvedAuth.baseUrl;

  const env = { ...baseEnv };
  if (effectiveAuthMethod === 'oauth') {
    delete env.XAI_API_KEY;
    delete env.GROK_API_KEY;
  } else if (effectiveApiKey) {
    env.XAI_API_KEY = effectiveApiKey;
    env.GROK_API_KEY = effectiveApiKey;
  }
  env.GROK_AUTH_METHOD = effectiveAuthMethod;
  if (effectiveBaseUrl) {
    applyGrokBaseUrlEnv(env, effectiveAuthMethod, effectiveBaseUrl);
  }
  env.GROK_NO_AUTO_UPDATE = '1';
  env.CI = env.CI || '1';

  const workCwd = cwd && cwd.trim() ? cwd.trim() : process.cwd();
  // Normalize empty → default so one-shot path asks the user (never silent auto).
  const effectiveMode = String(permissionMode || '').trim() || 'default';
  const autoApprove = isAutoApproveMode(effectiveMode);

  const terminalHost = new AcpTerminalHost({
    defaultCwd: workCwd,
    env,
    onEvent: (event, data) => {
      emit('terminal', { event, ...(data || {}) });
    },
    // Gate shell spawn when not in auto-approve modes (permission dialog).
    // Agent may also call session/request_permission first; double-gate is OK.
    authorizeCreate: async (info) => {
      if (isAutoApproveMode(effectiveMode)) return true;
      if (isDenyAllMode(effectiveMode)) return false;
      try {
        return await requestPermissionFromJava('run_terminal_command', {
          command: info.commandLine || info.command,
          cwd: info.cwd,
        });
      } catch {
        return false;
      }
    },
  });

  const client = new GrokAcpClient({
    env,
    cwd: workCwd,
    terminalHost,
    onStderr: (s) => {
      if (typeof onStderr === 'function') onStderr(s);
    },
    onFsWrite: (payload) => emit('fs_write', payload),
    onNotification: (method, params) => {
      emit('notification', { method, params });
    },
    onServerRequest: async (method, params, id, acp) => {
      emit('server_request', { method, params });

      // Permission / tool approval style requests → Claude-like UI in default mode
      if (isPermissionRequestMethod(method)) {
        const decision = await resolveAcpPermissionDecision(params, effectiveMode, {
          autoApprove: isAutoApproveMode(effectiveMode),
        });
        const info = extractPermissionToolInfo(params || {});
        emit('permission_decision', {
          method,
          toolName: decision.toolName,
          allowed: decision.allowed,
          optionId: decision.optionId,
          source: decision.source,
          toolCallId: info.input?._acp?.toolCallId || '',
          input: info.input,
        });
        acp.respond(id, decision.response);
        return true;
      }

      return false;
    },
  });

  client.start();

  try {
    // Use shared helpers (DRY with persistent-acp-service path)
    const hasApiKeyFromEnv =
      effectiveAuthMethod === 'oauth'
        ? false
        : !!(effectiveApiKey || env.XAI_API_KEY || env.GROK_API_KEY);
    const { init, methodId } = await initializeAndAuthenticate(client, {
      apiKey: effectiveApiKey,
      baseUrl: effectiveBaseUrl,
      hasApiKeyFromEnv,
      authMethod: effectiveAuthMethod,
    });
    emit('initialized', init);
    emit('authenticated', { methodId, hasApiKey: hasApiKeyFromEnv, authReason: resolvedAuth.reason });

    const sessionInfo = await ensureSession(client, { sessionId, cwd: workCwd, model });
    const activeSessionId = sessionInfo.sessionId;
    emit('session_id', activeSessionId);
    emit('session_new', sessionInfo.sessionMeta || {});

    // Always sync always-approve with mode (default must turn it OFF so the agent
    // keeps requesting session/request_permission instead of silent auto-run).
    // Keep liveStreaming=false: this control prompt must not enter the UI stream.
    await applyPermissionModeToSession(client, activeSessionId, effectiveMode);

    const promptBlocks = buildPromptBlocks({
      message,
      agentPrompt,
      openedFiles,
      attachments,
    });

    // Signal the normalizer to open [STREAM_START] only for the user turn.
    emit('prompt_phase_start', {});
    liveStreaming = true;

    const promptResult = await client.request(
      'session/prompt',
      {
        sessionId: activeSessionId,
        prompt: promptBlocks,
      },
      TURN_PROMPT_TIMEOUT_MS
    );
    emit('prompt_result', promptResult);

    return {
      sessionId: activeSessionId,
      promptResult,
      init,
    };
  } finally {
    await client.close();
  }
}


export function isPermissionRequestMethod(method) {
  if (!method) return false;
  const m = String(method);
  return (
    m === 'session/request_permission' ||
    m === 'request_permission' ||
    m.includes('permission') ||
    m.includes('Permission')
  );
}

/**
 * Map ACP session/request_permission params → Claude permission dialog fields.
 */
export function extractPermissionToolInfo(params = {}) {
  const toolCall = params.toolCall || params.tool_call || params.tool || {};
  const rawInput =
    toolCall.rawInput ||
    toolCall.raw_input ||
    toolCall.input ||
    params.input ||
    params.arguments ||
    {};
  const title = toolCall.title || params.title || '';
  const kind = String(toolCall.kind || params.kind || '').toLowerCase();
  const toolCallId =
    toolCall.toolCallId || toolCall.tool_call_id || params.toolCallId || params.tool_call_id || '';

  let toolName =
    toolCall.name ||
    toolCall.toolName ||
    params.toolName ||
    params.name ||
    '';

  if (!toolName) {
    if (kind === 'execute' || /bash|shell|terminal|command/i.test(title)) {
      // Grok ACP uses run_terminal_command (not Claude's Bash / run_terminal_cmd)
      toolName = 'run_terminal_command';
    } else if (kind === 'edit' || /edit|write|patch/i.test(title)) {
      toolName = 'Edit';
    } else if (kind === 'read' || /read|search|grep|glob/i.test(title)) {
      toolName = 'Read';
    } else if (title) {
      toolName = title;
    } else {
      toolName = 'Tool';
    }
  } else {
    // Normalize common aliases so UI treats Grok shell as command tool
    const lower = String(toolName).toLowerCase();
    if (
      lower === 'bash' ||
      lower === 'shell' ||
      lower === 'run_terminal_cmd' ||
      lower === 'execute_command' ||
      lower === 'exec_command' ||
      lower === 'shell_command'
    ) {
      toolName = 'run_terminal_command';
    }
  }

  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? { ...rawInput }
      : rawInput != null && rawInput !== ''
        ? { value: rawInput }
        : {};

  // Surface common command/path fields for the dialog even when nested oddly
  if (!input.command) {
    const cmd =
      rawInput?.command ||
      rawInput?.cmd ||
      params.command ||
      (typeof title === 'string' && title.startsWith('$') ? title.slice(1).trim() : '');
    if (cmd) input.command = cmd;
  }
  if (!input.path && !input.file_path) {
    const p = rawInput?.path || rawInput?.file_path || params.path;
    if (p) input.path = p;
  }

  input._acp = {
    toolCallId,
    kind,
    title,
    sessionId: params.sessionId || params.session_id || '',
    locations: toolCall.locations || params.locations || [],
  };

  return {
    toolName: String(toolName),
    input,
    kind,
    options: Array.isArray(params.options) ? params.options : [],
  };
}

function pickOptionId(options, preferred, fallback) {
  if (!Array.isArray(options) || options.length === 0) {
    return fallback;
  }
  const normalizedPreferred = preferred.map((p) => String(p).toLowerCase());
  for (const pref of normalizedPreferred) {
    const hit = options.find((o) => {
      const optionId = String(o?.optionId || o?.option_id || '').toLowerCase();
      const kind = String(o?.kind || '').toLowerCase();
      return (
        optionId === pref ||
        kind === pref ||
        optionId.replace(/_/g, '-') === pref.replace(/_/g, '-') ||
        kind.replace(/_/g, '-') === pref.replace(/_/g, '-') ||
        optionId.includes(pref.replace(/_/g, '-')) ||
        kind.includes(pref.replace(/_/g, '-'))
      );
    });
    if (hit) {
      return hit.optionId || hit.option_id || fallback;
    }
  }
  return fallback;
}

function isAcceptEditsMode(permissionMode) {
  const m = String(permissionMode || '').trim().toLowerCase();
  return m === 'acceptedits' || m === 'accept_edits' || m === 'accept-edits';
}

/**
 * Session-less one-shot asks (commit message / prompt enhancer) cannot render
 * a permission dialog. 'deny' auto-rejects every tool request instead of
 * auto-approving, so injected prompt text cannot drive tool execution.
 */
export function isDenyAllMode(permissionMode) {
  const m = String(permissionMode || '').trim().toLowerCase();
  return m === 'deny' || m === 'denyall' || m === 'deny-all' || m === 'never';
}

function isExecutionLike(toolName, kind, input) {
  if (kind === 'execute') return true;
  if (/bash|shell|terminal|execute|command|run_terminal/i.test(String(toolName || ''))) return true;
  if (input && (input.command || input.cmd)) return true;
  return false;
}

/**
 * Resolve ACP permission request using Claude permission dialog when needed.
 * @returns {{ allowed: boolean, optionId: string|null, response: object, toolName: string, source: string }}
 */
export async function resolveAcpPermissionDecision(
  params,
  permissionMode,
  { autoApprove = false, requestPermission = null } = {},
) {
  const info = extractPermissionToolInfo(params || {});
  const { toolName, input, kind, options } = info;

  if (isDenyAllMode(permissionMode)) {
    const rejectId = pickOptionId(
      options,
      ['reject-once', 'reject_once', 'reject', 'deny', 'cancel', 'cancelled'],
      null
    );
    return {
      allowed: false,
      optionId: rejectId,
      toolName,
      source: 'deny-all',
      response: rejectId
        ? { outcome: { outcome: 'selected', optionId: rejectId } }
        : { outcome: { outcome: 'cancelled' } },
    };
  }

  if (autoApprove || isAutoApproveMode(permissionMode)) {
    const optionId = pickOptionId(
      options,
      ['allow-always', 'allow_always', 'allow-once', 'allow_once', 'allow'],
      'allow-always'
    );
    return {
      allowed: true,
      optionId,
      toolName,
      source: 'auto-approve',
      response: { outcome: { outcome: 'selected', optionId } },
    };
  }

  // acceptEdits: auto-allow non-execution tools (Claude-like)
  if (isAcceptEditsMode(permissionMode) && !isExecutionLike(toolName, kind, input)) {
    const optionId = pickOptionId(
      options,
      ['allow-once', 'allow_once', 'allow-always', 'allow_always', 'allow'],
      'allow-once'
    );
    return {
      allowed: true,
      optionId,
      toolName,
      source: 'accept-edits',
      response: { outcome: { outcome: 'selected', optionId } },
    };
  }

  // default / plan / acceptEdits+exec → ask user via Claude permission IPC + dialog
  // (Injected `requestPermission` supports unit tests without FS IPC.)
  const askUser =
    typeof requestPermission === 'function' ? requestPermission : requestPermissionFromJava;
  let allowed = false;
  try {
    allowed = await askUser(toolName, input);
  } catch (e) {
    // Fail closed on IPC errors — still means we attempted the UI path, not auto-approve.
    allowed = false;
  }

  if (allowed) {
    const optionId = pickOptionId(
      options,
      ['allow-once', 'allow_once', 'allow-always', 'allow_always', 'allow'],
      'allow-once'
    );
    return {
      allowed: true,
      optionId,
      toolName,
      source: 'ui',
      response: { outcome: { outcome: 'selected', optionId } },
    };
  }

  const rejectId = pickOptionId(
    options,
    ['reject-once', 'reject_once', 'reject', 'deny', 'cancel', 'cancelled'],
    null
  );
  if (rejectId) {
    return {
      allowed: false,
      optionId: rejectId,
      toolName,
      source: 'ui',
      response: { outcome: { outcome: 'selected', optionId: rejectId } },
    };
  }

  return {
    allowed: false,
    optionId: null,
    toolName,
    source: 'ui',
    response: { outcome: { outcome: 'cancelled' } },
  };
}

export function isAutoApproveMode(permissionMode) {
  if (!permissionMode) return false;
  const m = String(permissionMode).trim().toLowerCase();
  return (
    m === 'bypasspermissions' ||
    m === 'yolo' ||
    m === 'auto' ||
    m === 'always-approve' ||
    m === 'alwaysapprove' ||
    m === 'dontask'
  );
}

/**
 * Build ACP prompt content blocks for a Grok turn.
 *
 * Multimodal (aligned with desktop-cc-gui / grok headless):
 *   text:  { type: "text", text }
 *   image: { type: "image", mimeType: "image/png", data: "<base64>" }
 *
 * When the user only attaches images with empty text, inject
 * GROK_IMAGE_ONLY_FALLBACK_TEXT so the payload stays valid.
 */
export function buildPromptBlocks({ message, agentPrompt, openedFiles, attachments }) {
  const blocks = [];
  let text = message || '';

  if (agentPrompt && String(agentPrompt).trim()) {
    text =
      `${text}\n\n## Agent Role and Instructions\n\n${String(agentPrompt).trim()}`;
  }

  // Load user-global rules for Grok from ~/.grok/grok-rules.md (if exists).
  // This allows persistent, user-level instructions without hardcoding in the plugin.
  try {
    const rulesPath = path.join(homedir(), '.grok', 'grok-rules.md');
    if (fs.existsSync(rulesPath)) {
      const rulesContent = fs.readFileSync(rulesPath, 'utf8').trim();
      if (rulesContent) {
        console.log('[Grok] Loaded global rules from ~/.grok/grok-rules.md (' + rulesContent.length + ' chars)');
        text += `\n\n## Global Grok Rules (~/.grok/grok-rules.md)\n\n${rulesContent}`;
      }
    }
  } catch (err) {
    // Non-fatal: don't break prompt building if the file is unreadable
    console.error('[Grok] Failed to read ~/.grok/grok-rules.md:', err?.message || err);
  }

  if (openedFiles && typeof openedFiles === 'object') {
    try {
      const serialized = JSON.stringify(openedFiles, null, 2);
      if (serialized && serialized !== '{}' && serialized !== 'null') {
        text += `\n\n## IDE Context (opened files)\n\`\`\`json\n${serialized}\n\`\`\``;
      }
    } catch {
      // ignore
    }
  }

  const { blocks: imageBlocks, loaded, errors } = buildGrokImageBlocks(
    Array.isArray(attachments) ? attachments : []
  );
  if (errors.length > 0) {
    console.error(
      `[Grok] image load issues: ${loaded} ok, ${errors.length} failed (${errors.join('; ')})`
    );
  }
  if (loaded > 0) {
    console.error(`[Grok] embedding ${loaded} image block(s) into ACP prompt`);
  }

  // Non-image attachments (or failed images): keep a text note so the agent
  // still knows something was attached.
  if (Array.isArray(attachments) && attachments.length > 0 && loaded === 0) {
    const names = attachments
      .map((a) => a?.fileName || a?.name || 'attachment')
      .join(', ');
    text += `\n\n## Attachments\nUser attached: ${names}`;
  }

  const trimmedText = String(text || '').trim();
  if (trimmedText) {
    blocks.push({ type: 'text', text });
  } else if (imageBlocks.length > 0) {
    // Grok requires at least one text content block with multimodal payloads.
    blocks.push({ type: 'text', text: GROK_IMAGE_ONLY_FALLBACK_TEXT });
  } else {
    blocks.push({ type: 'text', text: text || '' });
  }

  for (const imageBlock of imageBlocks) {
    blocks.push(imageBlock);
  }

  return blocks;
}
