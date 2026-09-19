/**
 * DSH session / workspace unary operations (ported from
 * desktop-cc-gui engine/dsh/session.rs).
 *
 * Callers use the legacy spelling of every endpoint; `DshHostClient` maps it
 * onto the host's dialect. The payload *shapes* differ per dialect and are
 * adapted here, plus the one behavioral rule this module owns: a session is
 * never created from a bare `cwd`. The host files such a session under
 * "Ungrouped" and never adopts it by directory afterwards, so both dialects
 * bind through the Workspace first (`workspace.create` → `session/create
 * {workspaceId}`). `session/prompt` additionally requires a client-minted
 * `requestId` on modern hosts.
 */

import { randomUUID } from 'node:crypto';
import { DshRemoteMux } from './stream-client.js';
import { MODERN_DIALECT } from './wire.js';

export const THREAD_PREFIX = 'dsh:';
export const PENDING_PREFIX = 'dsh-pending-';

function isModern(client) {
  return Boolean(client) && client.dialect === MODERN_DIALECT;
}

export function sessionIdFromThread(threadId) {
  const trimmed = String(threadId || '').trim();
  if (trimmed.startsWith(THREAD_PREFIX)) {
    return trimmed.slice(THREAD_PREFIX.length);
  }
  if (trimmed.startsWith(PENDING_PREFIX)) {
    return trimmed.slice(PENDING_PREFIX.length);
  }
  return trimmed;
}

export function threadIdForSession(sessionId) {
  return `${THREAD_PREFIX}${sessionId}`;
}

/**
 * Bind one project directory as a Workspace and return the host's value.
 *
 * Both dialects expose it, and it is idempotent per canonical directory: the
 * host resolves the path first and answers `created: false` for a directory it
 * already owns, so binding once per turn cannot duplicate the user's workspace
 * list.
 *
 * @param {object} client - negotiated host client.
 * @param {string} path - absolute project directory.
 * @returns {Promise<object>} the host's `{ workspace }` value.
 */
export async function createWorkspace(client, path) {
  return client.call('workspace.create', { path: String(path || '') });
}

export function workspaceIdFromCreate(value) {
  const id = value && value.workspace && value.workspace.workspaceId;
  if (typeof id !== 'string' || !id) {
    throw new Error('dsh workspace.create missing workspaceId');
  }
  return id;
}

/**
 * Create — or idempotently adopt — one session owned by a Workspace.
 *
 * `cwd` is deliberately never sent: a session created from a cwd alone has no
 * Workspace owner on the host, so it is filed under "Ungrouped" and stays
 * there — the host groups by explicit ownership, and only its very first
 * startup adopts sessions by directory. The Workspace, whose path is the
 * session's directory, is what puts the session under its project.
 *
 * @param {object} client - negotiated host client.
 * @param {string} workspaceId - Workspace that must own the session.
 * @param {string} [sessionId] - existing session to adopt into that Workspace.
 * @returns {Promise<string>} the session id the host settled on.
 * @throws when no Workspace id is available: an ungrouped session is a bug, not
 *   a fallback.
 */
export async function createSession(client, workspaceId, sessionId) {
  if (typeof workspaceId !== 'string' || !workspaceId) {
    throw new Error('dsh session.create requires a workspaceId to keep the session grouped');
  }
  const payload = { workspaceId };
  if (typeof sessionId === 'string' && sessionId.trim()) {
    payload.sessionId = sessionId.trim();
  }
  const value = await client.call('session.create', payload);
  const id = value && value.sessionId;
  if (typeof id !== 'string' || !id) {
    throw new Error('dsh session.create did not return a sessionId');
  }
  return id;
}

export async function selectModel(client, sessionId, provider, model, reasoningEffort) {
  const payload = { sessionId, provider, model };
  if (typeof reasoningEffort === 'string' && reasoningEffort.trim()) {
    payload.reasoningEffort = reasoningEffort.trim();
  }
  return client.call('session.selectModel', payload);
}

/**
 * DSH `session.prompt` content parts. Host Zod (`promptContentPartSchema`) is
 * `$strip` + `name?: string` — `name: null` is rejected, so only attach a
 * non-empty name.
 */
export function buildPromptContent(text, images = []) {
  const content = [{ type: 'text', text: String(text ?? '') }];
  for (const image of images) {
    if (!image || !image.data) {
      continue;
    }
    const part = {
      type: 'image',
      mediaType: image.mediaType || 'image/png',
      data: image.data,
    };
    const name = typeof image.name === 'string' ? image.name.trim() : '';
    if (name) {
      part.name = name;
    }
    content.push(part);
  }
  return content;
}

export async function prompt(client, sessionId, text, images = []) {
  const payload = {
    sessionId,
    mode: 'queue',
    content: buildPromptContent(text, images),
  };
  if (isModern(client)) {
    // Modern hosts persist the accepted user message under this identity.
    payload.requestId = randomUUID();
  }
  return client.call('session.prompt', payload);
}

export async function cancel(client, sessionId) {
  return client.call('session.cancel', { sessionId });
}

export async function fork(client, sessionId) {
  const value = await client.call('session.fork', { sessionId });
  const id = value && value.sessionId;
  if (typeof id !== 'string' || !id) {
    throw new Error('dsh session.fork did not return a sessionId');
  }
  return id;
}

export async function listSessions(client) {
  const value = await client.call('session.list', {});
  return Array.isArray(value && value.items) ? value.items : [];
}

/**
 * One backwards page of session history.
 *
 * Legacy hosts page straight from `session.history`. Modern hosts split it:
 * `session/follow`'s opening snapshot supplies the first window plus the
 * `cursor` that `session/page` needs as `throughSeq`, so the cursor is cached
 * per session for the follow-up pages.
 */
const historyCursors = new Map();
/** Bound on cached follow cursors; the oldest entry drops first (Map order). */
const HISTORY_CURSOR_CACHE_MAX = 64;

function rememberHistoryCursor(key, cursor) {
  historyCursors.delete(key);
  if (historyCursors.size >= HISTORY_CURSOR_CACHE_MAX) {
    historyCursors.delete(historyCursors.keys().next().value);
  }
  historyCursors.set(key, cursor);
}

function historyCursorKey(client, sessionId) {
  return `${client && client.origin ? client.origin : ''}:${sessionId}`;
}

/** How long a cold `session/follow` may take to deliver its opening snapshot. */
const FOLLOW_SNAPSHOT_TIMEOUT_MS = 15_000;

/**
 * Open one short-lived `session/follow` stream and resolve with its opening
 * snapshot. Modern hosts have no cold history read that works without a
 * cursor, so the snapshot is both the first window and the source of the
 * `cursor` that `session/page` needs afterwards.
 */
function openFollowSnapshot(client, sessionId, maxMessages) {
  return new Promise((resolve, reject) => {
    const mux = new DshRemoteMux(client.muxUrl(), { headers: client.muxHeaders() });
    let settled = false;
    const finish = (settle) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      mux.close();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('dsh session/follow snapshot timed out')));
    }, FOLLOW_SNAPSHOT_TIMEOUT_MS);

    mux.open('session/follow', {
      request: {
        address: { kind: 'session', sessionId },
        ...(Number.isInteger(maxMessages) && maxMessages > 0 ? { maxMessages } : {}),
        // `assistantStream` is the literal `true` when present; a history read
        // leaves it out entirely rather than sending `false`.
      },
    }, {
      onValue: (value) => {
        if (value && value.type === 'snapshot') {
          finish(() => resolve({
            cursor: value.cursor,
            records: Array.isArray(value.records) ? value.records.map(unwrapHistoryRecord) : [],
            hasMore: value.hasMore === true,
          }));
        }
      },
      onError: (error) => finish(() => reject(error)),
      onEnd: () => finish(() => reject(new Error('dsh session/follow ended before its snapshot'))),
    });
    mux.connect();
  });
}

async function modernHistoryPage(client, sessionId, maxMessages, beforeSeq) {
  const key = historyCursorKey(client, sessionId);
  const cachedCursor = historyCursors.get(key);
  if (beforeSeq === null || beforeSeq === undefined || cachedCursor === undefined) {
    const snapshot = await openFollowSnapshot(client, sessionId, maxMessages);
    rememberHistoryCursor(key, snapshot.cursor);
    return {
      events: snapshot.records,
      hasMore: snapshot.hasMore === true,
    };
  }
  let value;
  try {
    value = await client.call('session.page', {
      address: { kind: 'session', sessionId },
      throughSeq: cachedCursor,
      ...(Number.isInteger(beforeSeq) ? { beforeSeq } : {}),
      ...(Number.isInteger(maxMessages) && maxMessages > 0 ? { maxMessages } : {}),
    });
  } catch (error) {
    // A stale cursor (host restarted, session compacted) would fail every
    // later page the same way; drop it so the next read re-snapshots.
    historyCursors.delete(key);
    throw error;
  }
  const records = Array.isArray(value && value.records) ? value.records : [];
  return {
    events: records.map(unwrapHistoryRecord),
    hasMore: Boolean(value && value.hasMore),
  };
}

/** Modern history records wrap the durable event; legacy pages carry it bare. */
function unwrapHistoryRecord(record) {
  if (record && typeof record === 'object' && record.type === 'event' && record.event) {
    return record.event;
  }
  return record;
}

export async function history(client, sessionId, maxMessages, beforeSeq) {
  if (isModern(client)) {
    return modernHistoryPage(client, sessionId, maxMessages, beforeSeq);
  }
  const payload = { sessionId };
  if (Number.isInteger(maxMessages) && maxMessages > 0) {
    payload.maxMessages = maxMessages;
  }
  if (Number.isInteger(beforeSeq)) {
    payload.beforeSeq = beforeSeq;
  }
  return client.call('session.history', payload);
}

export async function archiveSession(client, sessionId) {
  return client.call('workspace.archiveSession', { sessionId });
}

export async function loadModels(client) {
  return client.call('llm.models', {});
}

/**
 * Flatten the `llm.models` catalog into `{id: "<provider>/<model>"}` rows,
 * mirroring desktop-cc-gui `flatten_llm_models_with_describe`.
 */
export function flattenLlmModels(catalog) {
  const groups = Array.isArray(catalog && catalog.groups) ? catalog.groups : [];
  const models = [];
  const seen = new Set();
  for (const group of groups) {
    const provider = typeof group.id === 'string' && group.id ? group.id : 'unknown';
    const groupName = typeof group.name === 'string' && group.name ? group.name : provider;
    const rows = Array.isArray(group.models) ? group.models : [];
    for (const model of rows) {
      const modelId = typeof model.id === 'string' ? model.id.trim() : '';
      if (!modelId) {
        continue;
      }
      const id = `${provider}/${modelId}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const modelName = typeof model.name === 'string' && model.name ? model.name : modelId;
      const efforts = model && model.reasoning && Array.isArray(model.reasoning.efforts)
        ? model.reasoning.efforts.map((effort) => effort && effort.id).filter(Boolean)
        : [];
      models.push({
        id,
        label: `${groupName} / ${modelName}`,
        description: efforts.length > 0 ? `effort: ${efforts.join(' / ')}` : provider,
      });
    }
  }
  return models;
}

/**
 * Default selection for the picker: the host's currently selected
 * `{provider, model}` from `host.describe`, else the first catalog entry.
 */
export function defaultDshModel(catalog, describe) {
  const provider = describe && typeof describe.provider === 'string' ? describe.provider : '';
  const model = describe && typeof describe.model === 'string' ? describe.model : '';
  if (provider && model) {
    return `${provider}/${model}`;
  }
  const models = flattenLlmModels(catalog);
  return models.length > 0 ? models[0].id : null;
}
