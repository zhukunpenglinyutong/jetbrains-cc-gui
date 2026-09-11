/**
 * DSH message service — sends one user turn through a persistent `dsh web`
 * host and maps the mux stream onto the shared bridge marker protocol.
 *
 * Flow (aligned with desktop-cc-gui engine/dsh/mod.rs send_user_turn):
 *   ensure host (adopt or spawn) → workspace.create(cwd) → session.create or
 *   reuse → session.selectModel (when changed) → subscribe mux →
 *   session.prompt(queue) → stream until Goal-aware turn settlement.
 *
 * Marker output is consumed by Java MarkerCliBridge / CodexMessageHandler.
 */

import {
  beginStream,
  emitJsonStringMarker,
  emitSendError,
  emitSessionId,
  emitToolResultMessage,
  emitToolUseMessage,
  emitUsage,
  endStream,
} from '../../utils/marker-protocol.js';
import {
  bridgeDshApproval,
  bridgeDshQuestion,
  bridgeModernApproval,
  bridgeModernQuestion,
  DshGoalSettlement,
  DshMuxConnection,
  peekMuxSessionId,
  projectFollowFrame,
  projectMuxFrame,
  projectRemoteEventFrame,
} from './events.js';
import { DshRemoteMux } from './stream-client.js';
import { ensureHost, runtimeSettingsFromEnv } from './supervisor.js';
import * as dshSession from './session.js';
import { MODERN_DIALECT } from './wire.js';

function logDebug(...args) {
  console.error('[DEBUG][DSH]', ...args);
}

const MUX_OPEN_TIMEOUT_MS = 15_000;
const SILENCE_TIMEOUT_MS = 15 * 60_000;
const BRIDGE_DRAIN_TIMEOUT_MS = 5_000;

function isImageAttachment(attachment) {
  const mediaType = attachment && typeof attachment.mediaType === 'string'
    ? attachment.mediaType.toLowerCase()
    : '';
  return mediaType.startsWith('image/');
}

export function splitModelTuple(model) {
  const trimmed = String(model || '').trim();
  if (!trimmed || trimmed === 'auto' || trimmed === 'default' || trimmed === 'dsh-default') {
    return null;
  }
  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    return { provider: '', model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

/**
 * ensure host (adopt or spawn) → workspace.create → session id (create or
 * reuse). Returns null after emitting the send error when any step fails.
 */
async function ensureSession(settings, workCwd, incomingSessionId) {
  let hostHandle;
  try {
    hostHandle = await ensureHost(settings);
  } catch (error) {
    emitSendError(error.message, 'DSH');
    return null;
  }
  const { client } = hostHandle;
  logDebug(`host ${hostHandle.origin} (${hostHandle.ownership})`);

  // Workspace binding — never let the session fall into the host cwd.
  // Modern hosts bind the directory on the session itself, so no workspace is
  // created there (and none of the user's workspace entries are touched).
  let workspaceId = '';
  try {
    const workspace = await dshSession.createWorkspace(client, workCwd);
    if (workspace) {
      workspaceId = dshSession.workspaceIdFromCreate(workspace);
    }
  } catch (error) {
    emitSendError(`dsh workspace.create failed: ${error.message}`, 'DSH');
    return null;
  }

  // Session identity: DSH returns the real id immediately; never mint a local UUID.
  let sessionId = dshSession.sessionIdFromThread(incomingSessionId);
  if (!sessionId) {
    try {
      sessionId = await dshSession.createSession(client, workspaceId, undefined, workCwd);
    } catch (error) {
      emitSendError(`dsh session.create failed: ${error.message}`, 'DSH');
      return null;
    }
  }
  return { client, sessionId };
}

/** Model selection — only when the composer picked an explicit tuple. */
async function applyModelSelection(client, sessionId, model, reasoningEffort) {
  const tuple = splitModelTuple(model);
  if (!tuple || !tuple.provider || !tuple.model) {
    return;
  }
  try {
    await dshSession.selectModel(
      client,
      sessionId,
      tuple.provider,
      tuple.model,
      reasoningEffort || undefined
    );
  } catch (error) {
    logDebug(`selectModel failed (continuing with session model): ${error.message}`);
  }
}

/**
 * Attachments: images become DSH image parts; everything else degrades to a
 * path note so the model still knows the file exists.
 */
function buildTurnContent(message, attachments) {
  const images = [];
  const nonImageNotes = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment || !attachment.data) {
      continue;
    }
    if (isImageAttachment(attachment)) {
      images.push({
        mediaType: attachment.mediaType,
        data: attachment.data,
        name: attachment.fileName || undefined,
      });
    } else if (attachment.fileName) {
      nonImageNotes.push(attachment.fileName);
    }
  }
  let text = String(message ?? '');
  if (nonImageNotes.length > 0) {
    text += `\n\n[Attached non-image files not sent inline: ${nonImageNotes.join(', ')}]`;
  }
  return { text, images };
}

function createTurnState() {
  return {
    settlement: new DshGoalSettlement(),
    settled: false,
    settleError: null,
    sawTurnStart: false,
    lastActivityAt: Date.now(),
    pendingBridges: new Set(),
    /** Modern hosts route waterfall answers by this per-generation id. */
    clientId: null,
  };
}

/** Marker emissions for stream events; returns false for non-stream kinds. */
function emitStreamEvent(event) {
  switch (event.kind) {
    case 'text-delta':
      emitJsonStringMarker('[CONTENT_DELTA]', event.text);
      return true;
    case 'reasoning-delta':
      emitJsonStringMarker('[THINKING_DELTA]', event.text);
      return true;
    case 'tool-call':
      emitToolUseMessage({ id: event.toolId, name: event.toolName, input: event.input });
      return true;
    case 'tool-result':
      emitToolResultMessage({
        toolUseId: event.toolId,
        content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? ''),
        isError: event.isError,
      });
      return true;
    case 'usage':
      emitUsage({
        input_tokens: event.inputTokens ?? 0,
        output_tokens: event.outputTokens ?? 0,
        cache_read_input_tokens: event.cachedTokens ?? 0,
      });
      return true;
    default:
      return false;
  }
}

/** Track an in-flight approval/question bridge so settlement can wait for it. */
function trackBridge(turn, bridge, label) {
  const tracked = bridge.catch((error) => logDebug(`${label} bridge failed: ${error.message}`));
  turn.pendingBridges.add(tracked);
  tracked.finally(() => turn.pendingBridges.delete(tracked));
}

function handleTurnEvent(client, sessionId, turn, event) {
  if (emitStreamEvent(event)) {
    return;
  }
  switch (event.kind) {
    case 'turn-start':
      turn.sawTurnStart = true;
      turn.settlement.feed('turn-start');
      break;
    case 'turn-completed':
      if (turn.settlement.feed('turn-completed') === 'settle') {
        turn.settled = true;
      }
      break;
    case 'turn-error':
      turn.settlement.feed('turn-error');
      turn.settleError = event.error || 'DSH turn failed';
      turn.settled = true;
      break;
    case 'goal-change':
      if (turn.settlement.feed('goal-change', event.data) === 'settle') {
        turn.settled = true;
      }
      break;
    case 'approval-request':
      trackBridge(turn, bridgeDshApproval(client, event, sessionId, logDebug), 'approval');
      break;
    case 'question-request':
      trackBridge(turn, bridgeDshQuestion(client, event, sessionId, logDebug), 'question');
      break;
    default:
      break;
  }
}

function createMuxHandler(client, sessionId, turn) {
  return (frame, rpcId, raw) => {
    const frameSessionId = peekMuxSessionId(raw);
    if (!frameSessionId || frameSessionId !== sessionId) {
      return;
    }
    turn.lastActivityAt = Date.now();
    const frameType = typeof frame.type === 'string' ? frame.type : '';
    const events = projectMuxFrame(frameType, frame, rpcId);
    for (const event of events) {
      handleTurnEvent(client, sessionId, turn, event);
    }
  };
}

/** Resolve true once the mux socket is open, false on timeout. */
function awaitMuxOpen(mux) {
  let timer = null;
  return Promise.race([
    mux.whenOpen().then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), MUX_OPEN_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Best-effort cancel on interrupt (SIGTERM from Java process manager). */
function registerShutdownCancel(client, sessionId, mux) {
  const onShutdownSignal = () => {
    dshSession.cancel(client, sessionId).catch(() => {});
    mux.close();
    process.exit(143);
  };
  process.once('SIGTERM', onShutdownSignal);
  process.once('SIGINT', onShutdownSignal);
}

/** Queue the user turn; returns false after emitting the send error on failure. */
async function promptTurn(client, sessionId, mux, text, images) {
  beginStream();
  try {
    const ack = await dshSession.prompt(client, sessionId, text, images);
    if (ack && ack.accepted === false) {
      throw new Error(`prompt rejected by host (${ack.reason || 'unknown reason'})`);
    }
    return true;
  } catch (error) {
    endStream();
    mux.close();
    emitSendError(`dsh session.prompt failed: ${error.message}`, 'DSH');
    return false;
  }
}

/**
 * Wait for Goal-aware settlement. Silence watchdog: no frames for this
 * session and no in-flight approval/question for a long stretch means the
 * turn terminal was lost (e.g. mux reconnect gap) — fail instead of hanging.
 */
function awaitSettlement(turn) {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (turn.settled) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (
        turn.pendingBridges.size === 0 &&
        Date.now() - turn.lastActivityAt > SILENCE_TIMEOUT_MS
      ) {
        clearInterval(poll);
        turn.settleError = 'DSH turn went silent — the host stopped streaming for this session';
        turn.settled = true;
        resolve();
      }
    }, 100);
  });
}

/** Let in-flight approval/question bridges finish their respond RPC. */
function settlePendingBridges(pendingBridges) {
  if (pendingBridges.size === 0) {
    return Promise.resolve();
  }
  let timer = null;
  return Promise.race([
    Promise.allSettled([...pendingBridges]),
    new Promise((resolve) => {
      timer = setTimeout(resolve, BRIDGE_DRAIN_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Subscribe the modern Remote streams for one turn.
 *
 * Two logical streams ride the single `/api/remote.mux` socket: `$events`
 * carries the forwarded waterfalls (approvals and questions) and `session/follow`
 * carries durable session events plus the opted-in assistant deltas. Nothing is
 * delivered until each `open` frame is sent.
 */
function subscribeModernStreams(client, sessionId, turn) {
  const mux = new DshRemoteMux(client.muxUrl(), {
    headers: client.muxHeaders(),
    log: logDebug,
  });
  mux.connect();

  mux.open('$events', {}, {
    onValue: (value) => {
      const instruction = projectRemoteEventFrame(value);
      if (!instruction) {
        return;
      }
      turn.lastActivityAt = Date.now();
      switch (instruction.kind) {
        case 'ready':
          turn.clientId = instruction.clientId;
          break;
        case 'approval-request':
          trackBridge(
            turn,
            bridgeModernApproval(client, turn.clientId, instruction, logDebug),
            'approval'
          );
          break;
        case 'question-request':
          trackBridge(
            turn,
            bridgeModernQuestion(client, turn.clientId, instruction, logDebug),
            'question'
          );
          break;
        default:
          break;
      }
    },
    onError: (error) => logDebug(`[dsh] $events stream error: ${error.message}`),
  });

  mux.open('session/follow', {
    request: {
      address: { kind: 'session', sessionId },
      // The opening snapshot is history, which the plugin renders from its own
      // reader; one record is enough to make the window legal.
      maxMessages: 1,
      assistantStream: true,
    },
  }, {
    onValue: (value) => {
      turn.lastActivityAt = Date.now();
      for (const event of projectFollowFrame(value)) {
        handleTurnEvent(client, sessionId, turn, event);
      }
    },
    onError: (error) => logDebug(`[dsh] follow stream error: ${error.message}`),
  });

  return mux;
}

/** Shared tail: wait for settlement, drain bridges, close the transport. */
async function finishTurn(turn, mux) {
  await awaitSettlement(turn);
  await settlePendingBridges(turn.pendingBridges);
  endStream();
  mux.close();

  if (turn.settleError) {
    emitSendError(turn.settleError, 'DSH');
    return;
  }
  if (!turn.sawTurnStart) {
    logDebug('turn settled without turn/start (queued turn may have been coalesced)');
  }
}

/** One turn against a modern host: `$events` + `session/follow` + prompt. */
async function runModernTurn(client, sessionId, text, images) {
  const turn = createTurnState();
  const mux = subscribeModernStreams(client, sessionId, turn);

  const opened = await awaitMuxOpen(mux);
  if (!opened) {
    mux.close();
    emitSendError('dsh mux WebSocket did not open in time', 'DSH');
    return;
  }

  registerShutdownCancel(client, sessionId, mux);
  if (!(await promptTurn(client, sessionId, mux, text, images))) {
    return;
  }

  await finishTurn(turn, mux);
}

/**
 * @param {object} options
 * @param {string} options.message
 * @param {string} [options.sessionId]
 * @param {string} [options.cwd]
 * @param {string} [options.model] "<provider>/<model>" or empty for host default
 * @param {string} [options.reasoningEffort]
 * @param {Array} [options.attachments] base64 {fileName, mediaType, data}
 * @param {string} [options.preset] DSH agent preset id ('' = default composition)
 */
export async function sendMessage(options = {}) {
  const {
    message = '',
    sessionId: incomingSessionId = '',
    cwd = '',
    model = '',
    reasoningEffort = '',
    attachments = [],
    preset = '',
  } = options;

  const settings = runtimeSettingsFromEnv();
  // Scope the preset to this turn; do not mutate process.env across tabs.
  settings.dshPreset = preset;
  const workCwd = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();

  const session = await ensureSession(settings, workCwd, incomingSessionId);
  if (!session) {
    return;
  }
  const { client, sessionId } = session;
  emitSessionId(sessionId);
  await applyModelSelection(client, sessionId, model, reasoningEffort);
  const { text, images } = buildTurnContent(message, attachments);

  if (client.dialect === MODERN_DIALECT) {
    await runModernTurn(client, sessionId, text, images);
    return;
  }

  // Mux subscription must be live before prompt, or early frames are lost.
  const turn = createTurnState();
  const mux = new DshMuxConnection(client.muxUrl(), createMuxHandler(client, sessionId, turn), logDebug);
  mux.connect();
  const opened = await awaitMuxOpen(mux);
  if (!opened) {
    mux.close();
    emitSendError('dsh mux WebSocket did not open in time', 'DSH');
    return;
  }

  registerShutdownCancel(client, sessionId, mux);
  if (!(await promptTurn(client, sessionId, mux, text, images))) {
    return;
  }

  await finishTurn(turn, mux);
}
