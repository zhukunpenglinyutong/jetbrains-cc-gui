/**
 * DSH session / workspace unary operations (ported from
 * desktop-cc-gui engine/dsh/session.rs).
 *
 * Callers use the legacy spelling of every endpoint; `DshHostClient` maps it
 * onto the host's dialect. Only the payload *shapes* differ per dialect and
 * are adapted here: a modern session binds its working directory directly
 * (`session/create {cwd}`) instead of going through `workspace.create`, and
 * `session/prompt` requires a client-minted `requestId`.
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

export async function createWorkspace(client, path) {
  if (isModern(client)) {
    // Modern hosts bind a session to `cwd` directly; creating a workspace per
    // turn would litter the user's workspace list for no benefit.
    return null;
  }
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
 * Extract the session membership of a workspace.create result.
 * Returns { sessionIds: Set<string>|null, archivedSessionIds: Set<string> }.
 * A null sessionIds set means the host did not report membership (fall back
 * to cwd matching, same as desktop-cc-gui).
 */
export function workspaceMembership(value) {
  const workspace = value && value.workspace;
  if (!workspace || typeof workspace !== 'object') {
    return { sessionIds: null, archivedSessionIds: new Set() };
  }
  const sessionIds = Array.isArray(workspace.sessionIds)
    ? new Set(workspace.sessionIds.filter((id) => typeof id === 'string'))
    : null;
  const archivedSessionIds = new Set(
    Array.isArray(workspace.archivedSessionIds)
      ? workspace.archivedSessionIds.filter((id) => typeof id === 'string')
      : []
  );
  return { sessionIds, archivedSessionIds };
}

/**
 * @param {object} client
 * @param {string} [workspaceId] legacy workspace binding ('' when unused)
 * @param {string} [sessionId] explicit session id to adopt
 * @param {string} [cwd] working directory (modern hosts bind this directly)
 */
export async function createSession(client, workspaceId, sessionId, cwd) {
  const payload = {};
  if (typeof workspaceId === 'string' && workspaceId) {
    payload.workspaceId = workspaceId;
  }
  if (isModern(client) && typeof cwd === 'string' && cwd) {
    payload.cwd = cwd;
  }
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
    historyCursors.set(key, snapshot.cursor);
    return {
      events: snapshot.records,
      hasMore: snapshot.hasMore === true,
    };
  }
  const value = await client.call('session.page', {
    address: { kind: 'session', sessionId },
    throughSeq: cachedCursor,
    ...(Number.isInteger(beforeSeq) ? { beforeSeq } : {}),
    ...(Number.isInteger(maxMessages) && maxMessages > 0 ? { maxMessages } : {}),
  });
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
