/**
 * DSH session / workspace unary operations (ported from
 * desktop-cc-gui engine/dsh/session.rs).
 */

export const THREAD_PREFIX = 'dsh:';
export const PENDING_PREFIX = 'dsh-pending-';

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

export async function createSession(client, workspaceId, sessionId) {
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
  return client.call('session.prompt', {
    sessionId,
    mode: 'queue',
    content: buildPromptContent(text, images),
  });
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

export async function history(client, sessionId, maxMessages, beforeSeq) {
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
