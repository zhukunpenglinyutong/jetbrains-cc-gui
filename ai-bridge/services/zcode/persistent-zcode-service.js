/**
 * Persistent ZCode runtime service (daemon mode).
 *
 * Owns a single long-lived `zcode app-server` child per daemon process and
 * multiplexes chat sessions over it: create/resume on demand, subscribe for
 * the event stream, drive turns with session/send, stop with the V4 command
 * surface (legacy session/stop as fallback for older CLIs).
 *
 * Markers are written via console.log so the daemon wraps each line into the
 * per-request NDJSON envelope; the Java bridge parses the same vocabulary as
 * the other CLI providers.
 */

import { ZcodeAppServerClient } from './zcode-appserver-client.js';
import { ZcodeEventNormalizer } from './zcode-event-normalizer.js';
import {
  resolveZcodeCliPath,
  resolveActiveProvider,
  buildRuntimeModel,
  buildZcodeEnv,
} from './zcode-config.js';

// =============================================================================
// State
// =============================================================================

let client = null;
let clientCwd = null;

/** Sessions activated (created or resumed) in this process generation. */
const activatedSessions = new Set();
/** Sessions with a live event subscription in this process generation. */
const subscribedSessions = new Set();
/** sessionId -> zcode permission mode (build|edit|plan|yolo). */
const sessionModes = new Map();
/** sessionId -> last applied modelId. */
const sessionModels = new Map();
/** sessionId -> runtimeModel last applied (for -32031 send recovery). */
const sessionRuntimeModels = new Map();
/** sessionId -> in-flight resume promise (concurrent resume dedupe). */
const resumeInFlight = new Map();
/** requestId family -> cached permission reply (server retries with new ids). */
const permissionAnswerCache = new Map();
/** sessionId+model -> available thoughtLevel values (string[]). */
const thoughtLevelCache = new Map();

/** Active turn being streamed: {sessionId, turnId, normalizer, settle}. */
let activeTurn = null;

const REVERSE_UNSUPPORTED = -32601;
const SESSION_NOT_ACTIVE = -32004;

// =============================================================================
// Client lifecycle
// =============================================================================

function ensureClient(cwd) {
  if (client && client.alive && clientCwd === cwd) return client;
  if (client) {
    try { client.close(); } catch { /* already dead */ }
    client = null;
    activatedSessions.clear();
    subscribedSessions.clear();
    resumeInFlight.clear();
  }

  const cliPath = resolveZcodeCliPath();
  if (!cliPath) {
    throw new Error(
      'ZCode CLI not found. Install the ZCode desktop client, or set ZCODE_CLI_PATH to zcode.cjs.',
    );
  }

  client = new ZcodeAppServerClient({
    nodePath: process.execPath,
    cliPath,
    cwd,
    env: buildZcodeEnv(),
    onReverseRequest: handleReverseRequest,
  });
  client.on('notification', handleNotification);
  client.on('stderrLine', (line) => {
    console.error(`[ZCODE-SERVER] ${line}`);
  });
  client.on('exit', (err) => {
    console.error(`[ZCODE] app-server exited: ${err.message}`);
    settleActiveTurn(false, 'ZCode app-server exited');
    activatedSessions.clear();
    subscribedSessions.clear();
  });
  client.start();
  clientCwd = cwd;
  return client;
}

function workspaceFor(cwd) {
  return { workspacePath: cwd, workspaceKey: cwd };
}

function isSessionNotActive(err) {
  return err?.code === SESSION_NOT_ACTIVE
    || /-32004|not active/i.test(err?.message || '');
}

async function resumeSession(cli, sessionId, cwd) {
  if (resumeInFlight.has(sessionId)) return resumeInFlight.get(sessionId);
  const promise = (async () => {
    await cli.request('session/resume', { sessionId, workspace: workspaceFor(cwd) });
    activatedSessions.add(sessionId);
    // Subscription bookkeeping dies with session eviction.
    subscribedSessions.delete(sessionId);
  })().finally(() => resumeInFlight.delete(sessionId));
  resumeInFlight.set(sessionId, promise);
  return promise;
}

/**
 * Run an operation, transparently resuming the session once on -32004.
 */
async function withResumeRetry(cli, sessionId, cwd, op) {
  try {
    return await op();
  } catch (err) {
    if (!isSessionNotActive(err)) throw err;
    await resumeSession(cli, sessionId, cwd);
    return op();
  }
}

// =============================================================================
// Permission mode mapping
// =============================================================================

/** CC GUI permission mode → zcode session mode. */
export function normalizeZcodeMode(permissionMode) {
  const mode = String(permissionMode || '').trim();
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'bypassPermissions':
    case 'yolo':
      return 'yolo';
    case 'acceptEdits':
      return 'edit';
    default:
      return 'build';
  }
}

// =============================================================================
// Reverse-request policy (server → host)
// =============================================================================

async function handleReverseRequest(method, params) {
  switch (method) {
    case 'session/requestRuntimePreferences':
      // Must be answered or session/create hangs. All-off is the safe host
      // default (no auto-resolution of user prompts, no memory injection).
      return {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      };

    case 'interaction/requestPermission':
      return answerPermission(params);

    case 'interaction/requestUserInput':
      // Interactive AskUserQuestion/ExitPlanMode dialogs are not wired to the
      // UI yet; decline so the agent continues autonomously.
      console.error(`[ZCODE] auto-declining user input request (tool=${params.toolName || 'unknown'})`);
      return { action: 'decline' };

    case 'interaction/requestProviderRuntimeHeaders':
      // Captcha-gated gateway header refresh — cannot be performed headlessly.
      return { headersApplied: false };

    case 'interaction/browserList':
      // No embedded browser in this host; protocol treats an empty list as
      // graceful "capability unavailable".
      return { browsers: [] };

    default: {
      const err = new Error(`unsupported reverse request: ${method}`);
      err.code = REVERSE_UNSUPPORTED;
      throw err;
    }
  }
}

function answerPermission(params) {
  const familyId = params.requestId || null;
  if (familyId && permissionAnswerCache.has(familyId)) {
    return permissionAnswerCache.get(familyId);
  }

  const mode = sessionModes.get(params.sessionId) || 'build';
  let reply;
  if (mode === 'plan') {
    reply = { decision: 'deny', reason: 'Plan mode: no changes allowed' };
  } else {
    // build / edit / yolo: prefer the option the server itself offers as
    // allow-once; fall back to a plain allow, then deny.
    const options = Array.isArray(params.options) ? params.options : [];
    const allowOption = options.find((o) => o?.response?.decision === 'allow');
    if (allowOption) {
      reply = allowOption.response;
    } else if (options.length === 0) {
      reply = { decision: 'allow', reason: 'Approved by host policy' };
    } else {
      reply = { decision: 'deny', reason: 'No allow option offered' };
    }
  }

  if (familyId) permissionAnswerCache.set(familyId, reply);
  return reply;
}

// =============================================================================
// Notification routing
// =============================================================================

function handleNotification({ method, params }) {
  if (method !== 'session/event') return;
  if (!activeTurn || params.sessionId !== activeTurn.sessionId) return;

  const terminal = activeTurn.normalizer.handleSessionEvent(params);
  if (params.type === 'turn.started' && params.turnId) {
    activeTurn.turnId = params.turnId;
  }
  if (terminal) {
    settleActiveTurn(terminal === 'completed');
  }
}

function settleActiveTurn(success, errorMessage = null) {
  if (!activeTurn) return;
  const turn = activeTurn;
  activeTurn = null;
  turn.settle({ success, errorMessage });
}

// =============================================================================
// Turn driving
// =============================================================================

function waitForTurn(sessionId, normalizer) {
  return new Promise((resolve) => {
    activeTurn = {
      sessionId,
      turnId: null,
      normalizer,
      settle: (outcome) => resolve(outcome),
    };
  });
}

async function applyThoughtLevel(cli, sessionId, reasoningEffort) {
  const effort = String(reasoningEffort || '').trim().toLowerCase();
  if (!effort || effort === 'auto' || effort === 'default') return;

  const cacheKey = sessionId;
  if (!thoughtLevelCache.has(cacheKey)) {
    try {
      const snapshot = await withResumeRetry(cli, sessionId, clientCwd, () =>
        cli.request('session/read', { sessionId }));
      const available = snapshot?.settings?.thoughtLevel?.available;
      thoughtLevelCache.set(cacheKey, Array.isArray(available)
        ? available.map((entry) => String(entry?.value ?? entry)).filter(Boolean)
        : []);
    } catch (err) {
      console.error(`[ZCODE] thoughtLevel probe failed: ${err.message}`);
      thoughtLevelCache.set(cacheKey, []);
    }
  }

  const available = thoughtLevelCache.get(cacheKey) || [];
  if (available.length === 0) return;
  // Levels are model-dependent (off/high/max, enabled/off, …); only apply a
  // level the model actually advertises.
  if (available.includes(effort)) {
    await cli.request('session/setThoughtLevel', { sessionId, thoughtLevel: effort })
      .catch((err) => console.error(`[ZCODE] setThoughtLevel failed: ${err.message}`));
  }
}

async function applyModel(cli, sessionId, model) {
  const modelId = String(model || '').trim();
  if (!modelId || modelId === 'auto' || modelId === 'default') return;
  if (sessionModels.get(sessionId) === modelId) return;

  // The app-server only knows the env-injected "anthropic" provider; the
  // desktop channel id must arrive with its full provider definition
  // (runtimeModel) or setModel fails with "Unsupported model".
  const runtimeModel = buildRuntimeModel(modelId);
  if (!runtimeModel) return;
  await withResumeRetry(cli, sessionId, clientCwd, () =>
    cli.request('session/setModel', {
      sessionId,
      model: { modelId, providerId: runtimeModel.model.providerId },
      runtimeModel,
    }));
  sessionModels.set(sessionId, modelId);
  sessionRuntimeModels.set(sessionId, runtimeModel);
  thoughtLevelCache.delete(sessionId);
}

function mapAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  const mapped = [];
  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;
    if (!att.data || typeof att.data !== 'string') continue;
    const sizeBytes = Buffer.byteLength(att.data, 'base64');
    mapped.push({
      kind: 'image',
      filename: att.fileName || 'image.png',
      mimeType: att.mediaType || 'image/png',
      sizeBytes,
      dataBase64: att.data,
    });
  }
  return mapped.length > 0 ? mapped : undefined;
}

/**
 * Send a message on a persistent app-server, streaming markers to stdout.
 */
export async function sendMessagePersistent(params = {}) {
  const message = String(params.message ?? params.prompt ?? '');
  const cwd = (params.cwd || process.cwd()).trim() || process.cwd();
  const permissionMode = params.permissionMode || 'default';
  const zcodeMode = normalizeZcodeMode(permissionMode);

  const cli = ensureClient(cwd);
  const workspace = workspaceFor(cwd);

  // --- Ensure session ---
  let sessionId = String(params.sessionId || '').trim();
  if (!sessionId) {
    const created = await cli.request('session/create', { workspace, mode: zcodeMode });
    sessionId = created?.session?.sessionId || created?.sessionId || '';
    if (!sessionId) throw new Error('session/create returned no sessionId');
    activatedSessions.add(sessionId);
  } else if (!activatedSessions.has(sessionId)) {
    await resumeSession(cli, sessionId, cwd);
  }
  sessionModes.set(sessionId, zcodeMode);
  console.log(`[SESSION_ID] ${sessionId}`);

  // --- Per-turn configuration (safe while no turn is running) ---
  await applyModel(cli, sessionId, params.model);
  await applyThoughtLevel(cli, sessionId, params.reasoningEffort);

  // --- Subscribe BEFORE send or events are lost ---
  if (!subscribedSessions.has(sessionId)) {
    await withResumeRetry(cli, sessionId, cwd, () =>
      cli.request('session/subscribe', {
        sessionId,
        deliveryKind: 'desktop-continuous',
        includeSnapshot: false,
      }));
    subscribedSessions.add(sessionId);
  }

  // --- Drive the turn ---
  const normalizer = new ZcodeEventNormalizer(
    (line) => console.log(line),
    (line) => console.error(line),
  );
  const turnOutcome = waitForTurn(sessionId, normalizer);

  const sendParams = { sessionId, content: message };
  const mappedAttachments = mapAttachments(params.attachments);
  if (mappedAttachments) sendParams.attachments = mappedAttachments;

  try {
    await withResumeRetry(cli, sessionId, cwd, () => cli.request('session/send', sendParams));
  } catch (err) {
    // -32031: a resumed session lost its model config; only a send carrying
    // the full runtimeModel clears the restore warning.
    const runtimeModel = sessionRuntimeModels.get(sessionId)
      || buildRuntimeModel(Object.keys(resolveActiveProvider()?.models || {})[0] || '');
    if (err?.code === -32031 && runtimeModel) {
      console.error('[ZCODE] send hit -32031, retrying with runtimeModel');
      try {
        await cli.request('session/send', { ...sendParams, runtimeModel });
      } catch (retryErr) {
        settleActiveTurn(false, retryErr.message);
      }
    } else {
      settleActiveTurn(false, err.message);
    }
  }

  const outcome = await turnOutcome;

  const success = !!outcome.success;
  const finalPayload = success
    ? { success: true, sessionId, result: outcome.errorMessage || 'completed' }
    : { success: false, sessionId, error: outcome.errorMessage || 'ZCode turn failed' };
  console.log(JSON.stringify(finalPayload));
  return finalPayload;
}

// =============================================================================
// Stop / lifecycle
// =============================================================================

/**
 * Stop the in-flight turn. V4 stop is near-instant and works across CLI
 * versions that have the v4 surface; older CLIs answer -32601 and fall back
 * to legacy session/stop. A stop during pure streaming produces no terminal
 * frame on the legacy event channel, so synthesize one after a short grace
 * window.
 */
export async function abortCurrentTurn() {
  const turn = activeTurn;
  if (!turn || !client || !client.alive) return;

  const sessionId = turn.sessionId;
  let v4Accepted = false;
  try {
    await client.request('v4/command', {
      commandId: `stop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      clientId: 'cc-gui',
      sessionId,
      type: 'stop',
      payload: {},
      issuedAt: Date.now(),
      connectionId: 'cc-gui',
      clientMode: 'desktop-continuous',
    });
    v4Accepted = true;
  } catch (err) {
    if (err?.code !== REVERSE_UNSUPPORTED) {
      console.error(`[ZCODE] v4 stop failed: ${err.message}`);
    }
  }

  if (!v4Accepted) {
    try {
      await client.request('session/stop', { sessionId });
    } catch (err) {
      console.error(`[ZCODE] session/stop failed: ${err.message}`);
    }
  }

  // Grace window for a real terminal frame; otherwise close the stream
  // ourselves so the UI does not spin forever.
  setTimeout(() => {
    if (activeTurn === turn) {
      console.error('[ZCODE] no terminal frame after stop; synthesizing turn close');
      settleActiveTurn(false, 'Stopped by user');
    }
  }, 2000).unref();
}

export async function setPermissionModePersistent(params = {}) {
  const sessionId = String(params.sessionId || '').trim();
  const zcodeMode = normalizeZcodeMode(params.mode || params.permissionMode);
  if (!sessionId) {
    return { applied: false, mode: zcodeMode };
  }
  sessionModes.set(sessionId, zcodeMode);
  if (!client || !client.alive || !activatedSessions.has(sessionId)) {
    return { applied: false, mode: zcodeMode };
  }
  try {
    await withResumeRetry(client, sessionId, clientCwd, () =>
      client.request('session/setMode', { sessionId, mode: zcodeMode }));
    return { applied: true, mode: zcodeMode };
  } catch (err) {
    console.error(`[ZCODE] setMode failed: ${err.message}`);
    return { applied: false, mode: zcodeMode, error: err.message };
  }
}

export async function preconnectPersistent(params = {}) {
  const cwd = (params.cwd || process.cwd()).trim() || process.cwd();
  ensureClient(cwd);
  return { preconnected: true };
}

export async function resetRuntimePersistent(params = {}) {
  const sessionId = String(params.sessionId || '').trim();
  if (sessionId) {
    activatedSessions.delete(sessionId);
    subscribedSessions.delete(sessionId);
    sessionModes.delete(sessionId);
    sessionModels.delete(sessionId);
    sessionRuntimeModels.delete(sessionId);
    thoughtLevelCache.delete(sessionId);
  } else {
    if (client) {
      try { client.close(); } catch { /* ignore */ }
      client = null;
      clientCwd = null;
    }
    activatedSessions.clear();
    subscribedSessions.clear();
    sessionModes.clear();
    sessionModels.clear();
    sessionRuntimeModels.clear();
    thoughtLevelCache.clear();
    resumeInFlight.clear();
  }
  settleActiveTurn(false, 'Runtime reset');
  return { reset: true };
}

export async function shutdownPersistentRuntimes() {
  settleActiveTurn(false, 'Daemon shutting down');
  if (client) {
    try { client.close(); } catch { /* ignore */ }
    client = null;
    clientCwd = null;
  }
}

// =============================================================================
// Usage
// =============================================================================

export async function getContextUsagePersistent(params = {}) {
  const sessionId = String(params.sessionId || '').trim();
  let used = Number(params.usedTokens) || 0;
  let max = Number(params.maxTokens) || 0;
  const model = params.model || sessionModels.get(sessionId) || '';

  if (sessionId && client && client.alive && activatedSessions.has(sessionId)) {
    try {
      const snapshot = await withResumeRetry(client, sessionId, clientCwd, () =>
        client.request('session/read', { sessionId }, 10_000));
      const usage = snapshot?.runtime?.contextUsage;
      if (usage && typeof usage === 'object') {
        const u = Number(usage.usedTokens ?? usage.used ?? usage.tokens);
        const m = Number(usage.maxTokens ?? usage.limit ?? usage.max);
        if (Number.isFinite(u) && u >= 0) used = u;
        if (Number.isFinite(m) && m > 0) max = m;
      }
    } catch (err) {
      console.error(`[ZCODE] contextUsage probe failed: ${err.message}`);
    }
  }

  if (!Number.isFinite(max) || max <= 0) max = 200_000;
  if (!Number.isFinite(used) || used < 0) used = 0;
  if (used > max) used = max;
  const free = Math.max(0, max - used);
  const percentage = Math.round((1000 * used) / max) / 10;

  const payload = {
    success: true,
    totalTokens: used,
    maxTokens: max,
    rawMaxTokens: max,
    percentage,
    model,
    isAutoCompactEnabled: false,
    source: 'zcode-session',
    categories: [
      { name: 'Conversation', tokens: used, color: 'claude' },
      { name: 'Free space', tokens: free, color: 'inactive' },
    ],
    gridRows: [[
      {
        color: 'claude', isFilled: used > 0, categoryName: 'Conversation',
        tokens: used, percentage, squareFullness: used > 0 ? 1 : 0,
      },
      {
        color: 'inactive', isFilled: false, categoryName: 'Free space',
        tokens: free, percentage: Math.round((1000 * free) / max) / 10,
        squareFullness: free > 0 ? Math.min(1, free / max) : 0,
      },
    ]],
    memoryFiles: [],
    mcpTools: [],
    agents: [],
  };
  console.log(JSON.stringify(payload));
  return payload;
}

export async function getUsagePersistent() {
  // Plan quota lives behind the vendor HTTP API (out of app-server scope);
  // return a structured unavailable payload so the Settings panel settles.
  const payload = {
    success: true,
    data: {
      unavailable: true,
      message: 'ZCode plan quota is shown in the ZCode desktop client.',
      source: 'plugin-fallback',
    },
  };
  console.log(JSON.stringify(payload));
  return payload;
}

// =============================================================================
// Testing
// =============================================================================

export const __testing = {
  normalizeZcodeMode,
  answerPermission,
  handleReverseRequest,
  getActiveTurn: () => activeTurn,
  resetAll: () => {
    activatedSessions.clear();
    subscribedSessions.clear();
    sessionModes.clear();
    sessionModels.clear();
    resumeInFlight.clear();
    permissionAnswerCache.clear();
    thoughtLevelCache.clear();
    activeTurn = null;
  },
};
