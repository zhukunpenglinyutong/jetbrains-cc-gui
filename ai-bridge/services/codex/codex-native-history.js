/**
 * Pure helpers for app-server history projections.
 *
 * The app-server cursor is opaque to the plugin. These helpers keep it
 * unchanged, merge overlapping pages by native identity, and distinguish a
 * metadata-only page from an authoritative empty transcript.
 */

import { projectCodexItemMessages } from './codex-item-projection.js';

const ID_FIELDS = Object.freeze(['id', 'turnId', 'turn_id', 'itemId', 'item_id']);
const RUNNING_TOOL_TYPES = new Set(['commandExecution', 'mcpToolCall', 'fileChange', 'imageView',
  'imageGeneration', 'webSearch', 'dynamicToolCall', 'collabAgentToolCall', 'contextCompaction']);

/**
 * Normalize a native page without guessing a CLI-version-specific schema.
 * @param {object|null} response native response
 * @param {'threads'|'turns'|'items'} kind projection kind
 * @returns {{items: object[], cursor: unknown, hasMore: boolean, complete: boolean, partial: boolean}}
 */
export function normalizeNativeHistoryPage(response, kind = 'items') {
  const value = response && typeof response === 'object' ? response : {};
  const candidates = kind === 'threads'
    ? value.data ?? value.threads
    : kind === 'turns'
      ? value.data ?? value.turns
      : value.data ?? value.items;
  const items = Array.isArray(candidates)
    ? candidates.filter((item) => item && typeof item === 'object')
    : [];
  const hasMore = value.hasMore === true || value.has_more === true
    || value.hasMoreTurns === true || value.has_more_turns === true
    || value.nextCursor !== null && value.nextCursor !== undefined;
  const cursor = value.nextCursor ?? value.next_cursor ?? value.cursor ?? null;
  const metadataOnly = kind !== 'threads' && items.length === 0
    && (value.hasMoreTurns === true || value.has_more_turns === true || hasMore);
  return {
    items,
    cursor,
    hasMore: hasMore || cursor !== null,
    complete: !metadataOnly && !hasMore && cursor === null,
    partial: metadataOnly || hasMore || cursor !== null,
  };
}

function identityOf(item, fallbackIndex) {
  if (item?.item?.id != null) return `${item.turnId ?? ''}:${item.item.id}`;
  for (const field of ID_FIELDS) {
    const value = item?.[field];
    if (typeof value === 'string' || typeof value === 'number') {
      return `${field}:${String(value)}`;
    }
  }
  // A page without a native id remains visible, but only within its page.
  return `anonymous:${fallbackIndex}`;
}

/** Reads one history operation without loading a writer or mixing transcript sources. */
export async function readNativeHistoryPage(read, { threadId, cursor = null, limit = 30, readMode = 'paged' } = {}) {
  if (!threadId) throw new Error('A native history read requires a thread id');
  const metadata = await read('thread/read', { threadId, includeTurns: readMode === 'full' });
  const thread = metadata.thread;
  if (!thread || thread.id !== threadId) throw new Error('Native history returned a different thread');
  let page;
  if (readMode === 'full') {
    if (!Array.isArray(thread.turns)) throw new Error('Native full history returned no turns array');
    page = { data: thread.turns, nextCursor: null };
  } else {
    try {
      page = await read('thread/turns/list', { threadId, cursor, limit, sortDirection: 'desc', itemsView: 'full' });
    } catch (error) {
      // Capability/storage errors select a full native read once. Authentication,
      // writer and transport failures remain failures; none start exec.
      if (error?.rpcCode !== -32601 && !/pagination (?:is )?not supported|does not support pagination|non-paginated.*history/i.test(error?.message ?? '')) throw error;
      const full = await read('thread/read', { threadId, includeTurns: true });
      if (full.thread?.id !== threadId) throw new Error('Native history returned a different thread');
      if (!Array.isArray(full.thread.turns)) throw new Error('Native full history returned no turns array');
      page = { data: full.thread.turns, nextCursor: null };
      readMode = 'full';
    }
  }
  if (!Array.isArray(page?.data ?? page?.turns)) throw new Error('Native turn history returned no turns array');
  const normalized = normalizeNativeHistoryPage(page, 'turns');
  const turns = mergeNativeHistoryPages([{ items: normalized.items }]);
  const orderedTurns = readMode === 'full' ? turns : [...turns].reverse();
  const messages = [];
  for (const turn of orderedTurns) {
    let entries = (turn.items ?? []).map((item) => ({ turnId: turn.id, item }));
    if (turn.itemsView && turn.itemsView !== 'full') {
      const pages = [];
      let itemCursor = null;
      const seen = new Set();
      do {
        const itemPage = await read('thread/items/list', {
          threadId, turnId: turn.id, cursor: itemCursor, limit: 100, sortDirection: 'asc',
        });
        if (!Array.isArray(itemPage?.data ?? itemPage?.items)) throw new Error('Native item history returned no items array');
        const response = normalizeNativeHistoryPage(itemPage);
        pages.push(response);
        itemCursor = response.cursor;
        if (itemCursor != null && seen.has(itemCursor)) throw new Error('Native item history repeated its cursor');
        seen.add(itemCursor);
      } while (itemCursor != null);
      entries = mergeNativeHistoryPages(pages);
    }
    for (const entry of entries) {
      const item = entry.item ?? entry;
      const turnId = entry.turnId ?? turn.id;
      // Native abort records close the turn while retaining started tool snapshots.
      // Legacy ImageGenerationBegin materializes an empty status until its end event.
      const legacyImageStarted = item.type === 'imageGeneration' && item.status === '';
      const reasoningWithoutStatus = item.type === 'reasoning' && !item.status;
      const displayItem = turnId === turn.id && ['interrupted', 'failed'].includes(turn.status)
        && (RUNNING_TOOL_TYPES.has(item.type) || item.type === 'reasoning')
        && (['inProgress', 'in_progress'].includes(item.status) || legacyImageStarted || reasoningWithoutStatus)
        ? { ...item, status: turn.status } : legacyImageStarted ? { ...item, status: 'in_progress' } : item;
      for (const raw of projectCodexItemMessages(displayItem, { threadId, turnId, authoritative: true })) {
        raw.historySource = 'native';
        const blocks = raw.message?.content ?? [];
        const itemTime = entry.completedAtMs ?? entry.startedAtMs ?? item.completedAtMs ?? item.startedAtMs;
        const turnTime = typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : null;
        const timestamp = itemTime ?? turnTime;
        if (raw.isCompactSummary) {
          raw.summarizeMetadata = { ...raw.summarizeMetadata,
            ...(timestamp != null ? { timestamp, timestampSource: itemTime != null ? 'item' : 'turn' } : {}) };
        }
        messages.push({
          type: raw.type, raw,
          content: blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'),
          ...(timestamp != null ? { timestamp } : {}),
        });
      }
    }
  }
  return { thread, messages, cursor: normalized.cursor, partial: normalized.partial,
    complete: normalized.complete, readMode, turnCount: turns.length,
    latestTurnStatus: orderedTurns.at(-1)?.status ?? null, latestTurnId: orderedTurns.at(-1)?.id ?? null };
}

/**
 * Merge pages in native display order while preserving the first occurrence
 * of each turn/item. A later complete snapshot replaces the earlier partial
 * value with the same native identity.
 * @param {Array<{items?: object[]}>} pages pages in display order
 * @returns {object[]}
 */
export function mergeNativeHistoryPages(pages) {
  const merged = [];
  const positions = new Map();
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const item of Array.isArray(page?.items) ? page.items : []) {
      const key = identityOf(item, merged.length);
      const existingIndex = positions.get(key);
      if (existingIndex === undefined) {
        positions.set(key, merged.length);
        merged.push({ ...item });
      } else {
        merged[existingIndex] = { ...merged[existingIndex], ...item };
      }
    }
  }
  return merged;
}

/**
 * Build the next opaque request parameters. The plugin never decodes or
 * rewrites a server cursor and only adds excludeTurns when the caller owns it.
 */
export function nextNativeHistoryParams({ cursor = null, excludeTurns, limit } = {}) {
  const params = {};
  if (cursor !== null && cursor !== undefined) params.cursor = cursor;
  if (typeof excludeTurns === 'boolean') {
    params.excludeTurns = excludeTurns;
  }
  if (Number.isInteger(limit) && limit > 0) params.limit = limit;
  return params;
}
