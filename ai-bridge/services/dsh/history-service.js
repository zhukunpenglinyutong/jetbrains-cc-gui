/**
 * DSH history service (ported from desktop-cc-gui engine/dsh/history.rs).
 *
 * The host owns the truth: list / load go through Host RPC, never the local
 * filesystem. Deletion is `workspace.archiveSession` — not a physical delete.
 * Read paths attach to an existing host only (never spawn).
 */

import { connectExisting, runtimeSettingsFromEnv } from './supervisor.js';
import {
  archiveSession,
  createWorkspace,
  history,
  listSessions as rpcListSessions,
  sessionIdFromThread,
  workspaceMembership,
} from './session.js';

const HISTORY_PAGE_SIZE = 200;
const HISTORY_MAX_PAGES = 40;

// ---------------------------------------------------------------------------
// Injected-context filtering (AGENTS.md / skills / runtime snapshot / goal XML)
// ---------------------------------------------------------------------------

function stripDshRuntimeXmlBlock(text, tag) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const lower = text.toLowerCase();
  const start = lower.indexOf(open.toLowerCase());
  if (start === -1) {
    return text;
  }
  const afterOpen = text.slice(start + open.length);
  const tagEnd = afterOpen.toLowerCase().indexOf('>');
  if (tagEnd === -1) {
    return text.slice(0, start);
  }
  const innerStart = start + open.length + tagEnd + 1;
  const relEnd = text.slice(innerStart).toLowerCase().indexOf(close.toLowerCase());
  if (relEnd === -1) {
    return text.slice(0, start);
  }
  const end = innerStart + relEnd + close.length;
  return text.slice(0, start) + text.slice(end);
}

export function isDshRuntimeContextText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('current runtime context.') || lower.startsWith('current runtime context:')) {
    return true;
  }
  let rest = trimmed;
  for (let i = 0; i < 12; i++) {
    const before = rest;
    for (const tag of ['system-reminder', 'available_skills', 'agent_skills', 'goal_round']) {
      rest = stripDshRuntimeXmlBlock(rest, tag);
    }
    if (rest === before) {
      break;
    }
  }
  return rest.trim().length === 0;
}

function dshSourceKind(data) {
  const kind = data && data.source && typeof data.source.kind === 'string'
    ? data.source.kind.trim()
    : '';
  return kind || null;
}

function isDshInjectedUserMessage(data, text) {
  const kind = dshSourceKind(data);
  if (kind && kind.toLowerCase() === 'user') {
    return false;
  }
  if (kind && kind.toLowerCase() === 'goal') {
    return false;
  }
  if (kind) {
    return true;
  }
  return isDshRuntimeContextText(text);
}

export function sanitizeDshSidebarTitle(title) {
  return isDshRuntimeContextText(title) ? '' : String(title || '');
}

// ---------------------------------------------------------------------------
// History fold (events → conversation messages)
// ---------------------------------------------------------------------------

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeDshToolArguments(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // keep raw
    }
    return trimmed;
  }
  return value;
}

function extractHistoryToolOutput(data) {
  const message = data && typeof data === 'object' ? data.message : null;
  const blocks = message && Array.isArray(message.content) ? message.content : null;
  const block = blocks && blocks.length > 0 ? blocks[0] : null;
  if (block && typeof block === 'object') {
    const text = asString(block.text).trim();
    if (text) {
      return text;
    }
    const content = block.content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const parts = [];
      for (const entry of content) {
        if (entry && typeof entry === 'object' && asString(entry.text)) {
          parts.push(entry.text);
        } else if (typeof entry === 'string' && entry) {
          parts.push(entry);
        }
      }
      const joined = parts.join('\n').trim();
      if (joined) {
        return joined;
      }
    }
    return block;
  }
  return message ?? null;
}

function flushAssistant(messages, bufs) {
  if (bufs.reasoning) {
    bufs.index += 1;
    messages.push({
      id: `dsh-reasoning-${bufs.index}`,
      role: 'assistant',
      text: bufs.reasoning,
      kind: 'reasoning',
    });
    bufs.reasoning = '';
  }
  if (bufs.assistant) {
    bufs.index += 1;
    messages.push({
      id: `dsh-assistant-${bufs.index}`,
      role: 'assistant',
      text: bufs.assistant,
      kind: 'message',
    });
    bufs.assistant = '';
  }
}

function foldUserMessage(messages, bufs, data) {
  flushAssistant(messages, bufs);
  let text = asString(data.text);
  if (!text && Array.isArray(data.content)) {
    text = data.content
      .map((block) => (block && asString(block.text)) || '')
      .join('');
  }
  if (text && !isDshInjectedUserMessage(data, text)) {
    bufs.index += 1;
    messages.push({
      id: `dsh-user-${bufs.index}`,
      role: 'user',
      text,
      kind: 'message',
      sourceKind: dshSourceKind(data),
    });
  }
}

function foldAssistantChunk(bufs, data) {
  const chunk = data.chunk && typeof data.chunk === 'object' ? data.chunk : data;
  const chunkType = asString(chunk.type);
  if (chunkType === 'text-delta') {
    bufs.assistant += asString(chunk.text);
  } else if (chunkType === 'reasoning-delta') {
    bufs.reasoning += asString(chunk.text);
  }
}

function foldAssistantMessage(messages, bufs, data) {
  if (!bufs.assistant && asString(data.text)) {
    bufs.assistant = asString(data.text);
  }
  flushAssistant(messages, bufs);
}

function foldToolCall(messages, bufs, data) {
  bufs.index += 1;
  // Prefer durable callId so a later tool/result pairs by id.
  const callId =
    asString(data.callId) ||
    asString(data.id) ||
    `dsh-tool-${bufs.index}`;
  messages.push({
    id: callId,
    role: 'assistant',
    text: '',
    kind: 'tool',
    toolType: asString(data.name) || null,
    title: asString(data.name) || null,
    toolInput: normalizeDshToolArguments(data.arguments ?? data.args),
    toolOutput: null,
    isError: false,
  });
}

function foldToolResult(messages, data) {
  const callId =
    asString(data.callId) ||
    asString(data.id) ||
    asString(data.toolCallId) ||
    asString(data.message && data.message.source && data.message.source.callId) ||
    asString(
      data.message &&
        Array.isArray(data.message.content) &&
        data.message.content[0] &&
        data.message.content[0].toolCallId
    ) ||
    null;
  const output = data.result ?? data.output ?? extractHistoryToolOutput(data);
  // Mirror the live path (events.js): history must not lose tool failures.
  const firstBlock =
    data.message && Array.isArray(data.message.content) && data.message.content.length > 0
      ? data.message.content[0]
      : null;
  const isError =
    Boolean(data.error) ||
    (firstBlock && typeof firstBlock === 'object' && firstBlock.isError === true);
  let finalOutput = output;
  if (data.error && finalOutput == null) {
    finalOutput = typeof data.error === 'string'
      ? data.error
      : asString(data.error.message) || asString(data.error.code) || JSON.stringify(data.error);
  }
  if (callId) {
    const target = [...messages].reverse().find((row) => row.kind === 'tool' && row.id === callId);
    if (target) {
      target.toolOutput = finalOutput;
      target.isError = isError;
      return;
    }
  }
  const last = [...messages].reverse().find((row) => row.kind === 'tool' && row.toolOutput == null);
  if (last) {
    last.toolOutput = finalOutput;
    last.isError = isError;
  }
}

export function foldHistoryEvents(entries) {
  const messages = [];
  const bufs = { assistant: '', reasoning: '', index: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = entry && typeof entry === 'object' && entry.event && typeof entry.event === 'object'
      ? entry.event
      : entry;
    if (!event || typeof event !== 'object') {
      continue;
    }
    const type = asString(event.type);
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    switch (type) {
      case 'user/message':
        foldUserMessage(messages, bufs, data);
        break;
      case 'assistant/chunk':
        foldAssistantChunk(bufs, data);
        break;
      case 'assistant/message':
        foldAssistantMessage(messages, bufs, data);
        break;
      case 'tool/call':
        foldToolCall(messages, bufs, data);
        break;
      case 'tool/result':
        foldToolResult(messages, data);
        break;
      case 'turn/end':
        flushAssistant(messages, bufs);
        break;
      default:
        break;
    }
  }
  flushAssistant(messages, bufs);
  return messages;
}

// ---------------------------------------------------------------------------
// Conversion to the Claude-shaped message JSON consumed by the Java readers
// ---------------------------------------------------------------------------

function claudeMessage(uuid, role, blocks) {
  return {
    type: role,
    uuid,
    message: { role, content: blocks },
  };
}

function toOutputText(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function toClaudeMessages(folded) {
  const out = [];
  for (const row of Array.isArray(folded) ? folded : []) {
    switch (row.kind) {
      case 'message':
        if (row.role === 'user') {
          out.push(claudeMessage(row.id, 'user', [{ type: 'text', text: row.text }]));
        } else {
          out.push(claudeMessage(row.id, 'assistant', [{ type: 'text', text: row.text }]));
        }
        break;
      case 'reasoning':
        out.push(claudeMessage(row.id, 'assistant', [{ type: 'thinking', thinking: row.text }]));
        break;
      case 'tool': {
        out.push(claudeMessage(`${row.id}-use`, 'assistant', [{
          type: 'tool_use',
          id: row.id,
          name: row.toolType || 'tool',
          input: row.toolInput && typeof row.toolInput === 'object' ? row.toolInput : {},
        }]));
        if (row.toolOutput != null) {
          out.push(claudeMessage(`${row.id}-result`, 'user', [{
            type: 'tool_result',
            tool_use_id: row.id,
            is_error: row.isError === true,
            content: toOutputText(row.toolOutput),
          }]));
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RPC drivers
// ---------------------------------------------------------------------------

function normalizePathForCompare(path) {
  let value = String(path || '').trim().replace(/\\/g, '/');
  while (value.length > 1 && value.endsWith('/')) {
    value = value.slice(0, -1);
  }
  return value;
}

/**
 * Workspace path equality. Exact match first — case-sensitive volumes (APFS
 * can be formatted case-sensitive) must not conflate `Foo/` and `foo/`.
 * Case-insensitive compare is only a fallback for win32/darwin default volumes.
 */
function pathsEqualForWorkspace(a, b) {
  const na = normalizePathForCompare(a);
  const nb = normalizePathForCompare(b);
  if (na === nb) {
    return true;
  }
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return false;
}

async function loadHistoryPages(client, sessionId) {
  const collected = [];
  let lastPage = null;
  let beforeSeq = null;
  for (let pageIndex = 0; pageIndex < HISTORY_MAX_PAGES; pageIndex++) {
    const page = await history(client, sessionId, HISTORY_PAGE_SIZE, beforeSeq);
    if (pageIndex === 0) {
      lastPage = page;
    }
    const events = Array.isArray(page && page.events) ? page.events : [];
    if (events.length === 0) {
      break;
    }
    collected.unshift(...events);
    const first = events[0];
    const nextBefore = Number.isInteger(first && first.seq)
      ? first.seq
      : Number.isInteger(first && first.event && first.event.seq)
        ? first.event.seq
        : null;
    if (!page.hasMore || nextBefore == null || nextBefore === beforeSeq) {
      break;
    }
    beforeSeq = nextBefore;
  }
  return { events: collected, lastPage };
}

/** channel command: list sessions for one project path. */
export async function listSessionsCommand({ cwd }) {
  const settings = runtimeSettingsFromEnv();
  try {
    const { client } = await connectExisting(settings);
    const workspace = await createWorkspace(client, cwd);
    const membership = workspaceMembership(workspace);
    const items = await rpcListSessions(client);
    const sessions = [];
    for (const item of items) {
      const sessionId = asString(item && item.sessionId);
      if (!sessionId) {
        continue;
      }
      if (membership.sessionIds) {
        if (!membership.sessionIds.has(sessionId) || membership.archivedSessionIds.has(sessionId)) {
          continue;
        }
      } else {
        const itemCwd = asString(item.cwd);
        if (!itemCwd || !pathsEqualForWorkspace(itemCwd, cwd)) {
          continue;
        }
      }
      if (item.blank === true) {
        continue;
      }
      const title = sanitizeDshSidebarTitle(
        item.projections && item.projections.values && asString(item.projections.values.title)
      );
      const stats = item.projections && item.projections.values && item.projections.values.sessionStats;
      sessions.push({
        sessionId,
        title: title || `DSH session ${sessionId.slice(0, 8)}`,
        messageCount: stats && Number.isInteger(stats.turns) ? stats.turns : 0,
        lastTimestamp: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
        firstTimestamp: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
        cwd: asString(item.cwd),
        provider: 'dsh',
      });
    }
    sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    console.log(JSON.stringify({
      success: true,
      sessions,
      sessionCount: sessions.length,
      provider: 'dsh',
      total: sessions.reduce((sum, session) => sum + session.messageCount, 0),
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      provider: 'dsh',
      sessions: [],
      error: `Failed to read DSH sessions: ${error.message}`,
    }));
  }
}

/** channel command: load one session's messages (Claude-shaped). */
export async function loadSessionCommand({ sessionId }) {
  const settings = runtimeSettingsFromEnv();
  const id = sessionIdFromThread(sessionId);
  try {
    const { client } = await connectExisting(settings);
    const { events, lastPage } = await loadHistoryPages(client, id);
    const folded = foldHistoryEvents(events);
    const messages = toClaudeMessages(folded);
    const tokenUsage = lastPage && lastPage.projections && lastPage.projections.values
      ? lastPage.projections.values.tokenUsage
      : null;
    console.log(JSON.stringify({
      success: true,
      provider: 'dsh',
      sessionId: id,
      messages,
      usage: tokenUsage && typeof tokenUsage === 'object'
        ? {
            input_tokens: tokenUsage.uncachedInputTokens ?? tokenUsage.inputTokens ?? 0,
            output_tokens: tokenUsage.outputTokens ?? 0,
            cache_read_input_tokens: tokenUsage.cacheReadTokens ?? tokenUsage.cachedTokens ?? 0,
          }
        : null,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      provider: 'dsh',
      sessionId: id,
      messages: [],
      error: `Failed to load DSH session: ${error.message}`,
    }));
  }
}

/** channel command: archive (the DSH "delete"). */
export async function deleteSessionCommand({ sessionId }) {
  const settings = runtimeSettingsFromEnv();
  const id = sessionIdFromThread(sessionId);
  try {
    const { client } = await connectExisting(settings);
    await archiveSession(client, id);
    console.log(JSON.stringify({ success: true, provider: 'dsh', sessionId: id, archived: true }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      provider: 'dsh',
      sessionId: id,
      error: `Failed to archive DSH session: ${error.message}`,
    }));
  }
}
