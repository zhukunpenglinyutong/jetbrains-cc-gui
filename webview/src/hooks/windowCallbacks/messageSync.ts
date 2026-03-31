/**
 * messageSync.ts
 *
 * Pure utility functions for message identity preservation, optimistic message
 * handling, and streaming content repair.  These functions have no React state
 * dependencies and receive everything they need via parameters.
 */

import type { ClaudeMessage, ClaudeRawMessage } from '../../types';
import type { StreamingPatchState } from '../useStreamingMessages';

/** Normalize CRLF / CR line endings to LF for consistent streaming comparisons. */
export const normalizeStreamingNewlines = (value: string): string => value.replace(/\r\n?/g, '\n');

/** Time window (ms) for matching optimistic messages with backend messages. */
export const OPTIMISTIC_MESSAGE_TIME_WINDOW = 5000;

// ---------------------------------------------------------------------------
// Raw-field helpers
// ---------------------------------------------------------------------------

export const getRawUuid = (msg: ClaudeMessage | undefined): string | undefined => {
  const raw = msg?.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const rawObj = raw as Record<string, unknown>;
  return typeof rawObj.uuid === 'string' ? rawObj.uuid : undefined;
};

export const stripUuidFromRaw = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  const rawObj = raw as Record<string, unknown>;
  if (!('uuid' in rawObj)) return raw;
  const { uuid: _uuid, ...rest } = rawObj;
  return rest;
};

// ---------------------------------------------------------------------------
// Identity preservation
// ---------------------------------------------------------------------------

/**
 * Merge identity fields (timestamp, uuid) from prevMsg into nextMsg so that
 * React referential equality checks remain stable across backend re-sends.
 */
export const preserveMessageIdentity = (
  prevMsg: ClaudeMessage | undefined,
  nextMsg: ClaudeMessage,
): ClaudeMessage => {
  if (!prevMsg?.timestamp) return nextMsg;
  if (prevMsg.type !== nextMsg.type) return nextMsg;

  const prevUuid = getRawUuid(prevMsg);
  const nextUuid = getRawUuid(nextMsg);

  const nextWithStableTimestamp =
    nextMsg.timestamp === prevMsg.timestamp
      ? nextMsg
      : { ...nextMsg, timestamp: prevMsg.timestamp };

  if (!prevUuid && nextUuid) {
    return {
      ...nextWithStableTimestamp,
      raw: stripUuidFromRaw(nextWithStableTimestamp.raw) as ClaudeMessage['raw'],
    };
  }

  return nextWithStableTimestamp;
};

/**
 * If the previous list ended with an optimistic user message that has not yet
 * been matched by a backend message, keep it appended to nextList.
 * Also merges attachment blocks from the optimistic message into the matched
 * backend message so non-image file attachments remain visible.
 */
export const appendOptimisticMessageIfMissing = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
): ClaudeMessage[] => {
  const lastPrev = prevList[prevList.length - 1];
  if (!lastPrev?.isOptimistic) return nextList;

  const optimisticMsg = lastPrev;

  // Extract optimistic raw object once, reused for both matching and attachment merge (I4: js-cache-property-access).
  // NOTE: `as Record<string, unknown>` casts are used because ClaudeMessage.raw
  // is typed as `ClaudeRawMessage | string | undefined` and we need uniform property access.
  const optimisticRawObj = (optimisticMsg.raw && typeof optimisticMsg.raw === 'object')
    ? optimisticMsg.raw as Record<string, unknown>
    : undefined;
  const optimisticMsgField = optimisticRawObj?.message as Record<string, unknown> | undefined;
  const optimisticContentBlocks: unknown[] = Array.isArray(optimisticMsgField?.content)
    ? optimisticMsgField!.content as unknown[]
    : [];
  const optimisticFirstText = (optimisticContentBlocks[0] as Record<string, unknown> | undefined)?.text;

  const matchFn = (m: ClaudeMessage) =>
    m.type === 'user' &&
    (m.content === optimisticMsg.content ||
      m.content === optimisticFirstText) &&
    m.timestamp &&
    optimisticMsg.timestamp &&
    Math.abs(
      new Date(m.timestamp).getTime() - new Date(optimisticMsg.timestamp).getTime(),
    ) < OPTIMISTIC_MESSAGE_TIME_WINDOW;

  const matchedIndex = nextList.findIndex(matchFn);
  if (matchedIndex < 0) {
    return [...nextList, optimisticMsg];
  }

  // Backend message matched the optimistic message.  Preserve attachment blocks
  // from the optimistic message into the backend message's raw data; otherwise
  // non-image file attachments won't be visible.
  if (optimisticContentBlocks.length > 0) {
    const attachmentBlocks = optimisticContentBlocks.filter(
      (b: unknown) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'attachment',
    );
    if (attachmentBlocks.length > 0) {
      const backendMsg = nextList[matchedIndex];
      const backendRaw = (backendMsg.raw && typeof backendMsg.raw === 'object')
        ? backendMsg.raw as Record<string, unknown>
        : {} as Record<string, unknown>;
      const backendMsgField = backendRaw.message as Record<string, unknown> | undefined;
      const backendContent: unknown[] = Array.isArray(backendMsgField?.content)
        ? backendMsgField!.content as unknown[]
        : Array.isArray(backendRaw.content)
          ? backendRaw.content as unknown[]
          : [];
      const mergedContent = [...attachmentBlocks, ...backendContent];
      const mergedRaw = {
        ...backendRaw,
        message: { ...(backendMsgField ?? {}), content: mergedContent },
      };
      const result = [...nextList];
      result[matchedIndex] = { ...backendMsg, raw: mergedRaw as ClaudeMessage['raw'] };
      return result;
    }
  }

  return nextList;
};

/**
 * Preserve the identity (timestamp / uuid) of the last assistant message
 * across list updates.
 */
export const preserveLastAssistantIdentity = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  findLastAssistantIndex: (messages: ClaudeMessage[]) => number,
): ClaudeMessage[] => {
  const prevAssistantIdx = findLastAssistantIndex(prevList);
  const nextAssistantIdx = findLastAssistantIndex(nextList);
  if (prevAssistantIdx < 0 || nextAssistantIdx < 0) return nextList;

  const prevAssistant = prevList[prevAssistantIdx];
  const nextAssistant = nextList[nextAssistantIdx];
  // Guard: only preserve identity when both assistants prove they belong to the same turn.
  // Missing nextAssistant.__turnId is treated as "cannot prove same turn", so fail closed.
  if (prevAssistant.__turnId !== undefined) {
    if (nextAssistant.__turnId === undefined || prevAssistant.__turnId !== nextAssistant.__turnId) {
      return nextList;
    }
  }
  const stabilized = preserveMessageIdentity(prevAssistant, nextAssistant);
  if (stabilized === nextAssistant) return nextList;

  const copy = [...nextList];
  copy[nextAssistantIdx] = stabilized;
  return copy;
};

/**
 * When streaming is active, prevent the backend from replacing the streamed
 * content with a shorter (stale) snapshot.
 *
 * Accepts primitive values (not refs) so callers can pass pre-snapshotted values,
 * guaranteeing idempotent results under React StrictMode double-invocation.
 */
export const preserveStreamingAssistantContent = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  isStreaming: boolean,
  streamingContent: string,
  findLastAssistantIndex: (messages: ClaudeMessage[]) => number,
  patchAssistantForStreaming: (msg: ClaudeMessage, patchState?: StreamingPatchState) => ClaudeMessage,
): ClaudeMessage[] => {
  if (!isStreaming) return nextList;

  const prevAssistantIdx = findLastAssistantIndex(prevList);
  const nextAssistantIdx = findLastAssistantIndex(nextList);
  if (prevAssistantIdx < 0 || nextAssistantIdx < 0) return nextList;

  const prevAssistant = prevList[prevAssistantIdx];
  const nextAssistant = nextList[nextAssistantIdx];
  if (prevAssistant.type !== 'assistant' || nextAssistant.type !== 'assistant') {
    return nextList;
  }

  // Guard: only preserve streaming content when both assistants prove they belong to the same turn.
  // Missing nextAssistant.__turnId is treated as "cannot prove same turn", so fail closed.
  if (prevAssistant.__turnId !== undefined) {
    if (nextAssistant.__turnId === undefined || prevAssistant.__turnId !== nextAssistant.__turnId) {
      return nextList;
    }
  }

  const previousContent = prevAssistant.content || '';
  const bufferedContent = streamingContent || '';
  const preferredContent =
    bufferedContent.length > previousContent.length ? bufferedContent : previousContent;
  const nextContent = nextAssistant.content || '';

  if (!preferredContent || preferredContent.length <= nextContent.length) {
    return nextList;
  }

  const copy = [...nextList];
  copy[nextAssistantIdx] = patchAssistantForStreaming({
    ...nextAssistant,
    content: preferredContent,
    isStreaming: true,
  }, {
    canonicalText: preferredContent,
  });
  return copy;
};

/**
 * When Codex compacts or summarizes a long conversation, backend snapshots can
 * briefly shrink and omit the newest in-memory turn. Preserve that trailing
 * turn locally until the backend catches up, instead of wiping it from the UI.
 */
export const preserveLatestMessagesOnShrink = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  provider: string,
): ClaudeMessage[] => {
  if (provider !== 'codex') return nextList;
  if (nextList.length >= prevList.length) return nextList;
  if (prevList.length === 0 || nextList.length === 0) return nextList;

  const preservedTail = prevList.slice(nextList.length);
  if (preservedTail.length === 0) return nextList;

  const hasStreamingTail = preservedTail.some((msg) => msg.type === 'assistant' && (msg.isStreaming || !!msg.__turnId));
  const hasRecentUserTail = preservedTail.some((msg) => msg.type === 'user');
  if (!hasStreamingTail && !hasRecentUserTail) {
    return nextList;
  }

  return [...nextList, ...preservedTail];
};

// ---------------------------------------------------------------------------
// Streaming assistant preservation
// ---------------------------------------------------------------------------

/**
 * Ensure a streaming assistant message is not lost when updateMessages replaces
 * the entire message list. Returns the (possibly amended) result list and the
 * index of the streaming assistant inside it.
 *
 * The function has two paths:
 * 1. Primary — refs are valid (normal streaming).
 * 2. Fallback — refs already cleared (race condition). Uses message-level
 *    `isStreaming` + `__turnId` markers to recover.
 *
 * Recovered assistants are inserted immediately after the latest user message in
 * `resultList` so the current turn can never render assistant-before-user.
 */
export const ensureStreamingAssistantInList = (
  prevList: ClaudeMessage[],
  resultList: ClaudeMessage[],
  isStreaming: boolean,
  streamingTurnId: number,
): { list: ClaudeMessage[]; streamingIndex: number } => {
  const insertAfterLatestUser = (streamingAssistant: ClaudeMessage): { list: ClaudeMessage[]; streamingIndex: number } => {
    for (let i = resultList.length - 1; i >= 0; i -= 1) {
      if (resultList[i]?.type === 'user') {
        const result = [...resultList];
        result.splice(i + 1, 0, streamingAssistant);
        return { list: result, streamingIndex: i + 1 };
      }
    }

    const result = [...resultList, streamingAssistant];
    return { list: result, streamingIndex: result.length - 1 };
  };

  // Primary path: refs are still valid
  if (isStreaming && streamingTurnId > 0) {
    const existingIdx = resultList.findIndex(
      (m) => m.__turnId === streamingTurnId && m.type === 'assistant',
    );
    if (existingIdx >= 0) {
      return { list: resultList, streamingIndex: existingIdx };
    }

    let streamingAssistant: ClaudeMessage | undefined;
    for (let i = prevList.length - 1; i >= 0; i -= 1) {
      if (prevList[i].__turnId === streamingTurnId && prevList[i].type === 'assistant') {
        streamingAssistant = prevList[i];
        break;
      }
    }

    if (streamingAssistant) {
      return insertAfterLatestUser(streamingAssistant);
    }

    return { list: resultList, streamingIndex: -1 };
  }

  // Fallback path: refs already cleared (race condition).
  // Only consider the most recent streaming assistant in prevList.
  for (let i = prevList.length - 1; i >= 0; i -= 1) {
    const msg = prevList[i];
    if (msg.type === 'assistant' && msg.isStreaming && msg.__turnId && msg.__turnId > 0) {
      const alreadyPresent = resultList.some((m) => {
        if (m.type !== 'assistant') return false;
        if (m.__turnId === msg.__turnId) return true;
        if (msg.timestamp && m.timestamp === msg.timestamp) return true;
        return false;
      });
      if (!alreadyPresent) {
        return insertAfterLatestUser(msg);
      }
      // Already in resultList — no recovery needed
      break;
    }
  }

  return { list: resultList, streamingIndex: -1 };
};

// ---------------------------------------------------------------------------
// Re-export ClaudeRawMessage so callers can use it without an extra import
// ---------------------------------------------------------------------------
export type { ClaudeRawMessage };
