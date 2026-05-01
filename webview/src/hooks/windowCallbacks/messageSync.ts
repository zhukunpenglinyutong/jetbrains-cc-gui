/**
 * messageSync.ts
 *
 * Pure utility functions for message identity preservation, optimistic message
 * handling, and streaming content repair.  These functions have no React state
 * dependencies and receive everything they need via parameters.
 */

import type { MutableRefObject } from 'react';
import type { ClaudeContentOrResultBlock, ClaudeMessage, ClaudeRawMessage } from '../../types';

/** Time window (ms) for matching optimistic messages with backend messages. */
export const OPTIMISTIC_MESSAGE_TIME_WINDOW = 5000;

// ---------------------------------------------------------------------------
// Raw-field helpers
// ---------------------------------------------------------------------------

const getRawContentBlocks = (msg: ClaudeMessage | undefined): unknown[] => {
  const raw = msg?.raw;
  if (!raw || typeof raw !== 'object') return [];

  const rawObj = raw as Record<string, unknown>;
  if (rawObj.message && typeof rawObj.message === 'object') {
    const messageObj = rawObj.message as Record<string, unknown>;
    if (Array.isArray(messageObj.content)) {
      return messageObj.content;
    }
  }
  if (Array.isArray(rawObj.content)) {
    return rawObj.content;
  }
  return [];
};

const getRawTextContent = (msg: ClaudeMessage | undefined): string => {
  const lines: string[] = [];
  for (const block of getRawContentBlocks(msg)) {
    if (!block || typeof block !== 'object') continue;
    const candidate = block as Record<string, unknown>;
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      lines.push(candidate.text);
    }
  }
  return lines.join('\n');
};

const hasVisualAttachmentBlock = (msg: ClaudeMessage | undefined): boolean => {
  return getRawContentBlocks(msg).some((block) => {
    if (!block || typeof block !== 'object') return false;
    const candidate = block as Record<string, unknown>;
    return candidate.type === 'image' || candidate.type === 'attachment';
  });
};

export const getRawUuid = (msg: ClaudeMessage | undefined): string | undefined => {
  const raw = msg?.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const rawObj = raw as Record<string, unknown>;
  return typeof rawObj.uuid === 'string' ? rawObj.uuid : undefined;
};

export const stripUuidFromRaw = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  const rawObj = raw as any;
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
      raw: stripUuidFromRaw(nextWithStableTimestamp.raw) as any,
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
  const optimisticRawText = getRawTextContent(optimisticMsg);
  const optimisticHasVisualAttachment = hasVisualAttachmentBlock(optimisticMsg);

  const matchFn = (m: ClaudeMessage) => {
    if (m.type !== 'user' || !m.timestamp || !optimisticMsg.timestamp) {
      return false;
    }

    const withinWindow = Math.abs(
      new Date(m.timestamp).getTime() - new Date(optimisticMsg.timestamp).getTime(),
    ) < OPTIMISTIC_MESSAGE_TIME_WINDOW;
    if (!withinWindow) {
      return false;
    }

    const candidateContent = m.content ?? '';
    const optimisticContent = optimisticMsg.content ?? '';
    const candidateRawText = getRawTextContent(m);

    const contentMatches =
      (optimisticContent.length > 0 && candidateContent === optimisticContent) ||
      (optimisticRawText.length > 0 &&
        (candidateContent === optimisticRawText || candidateRawText === optimisticRawText));
    if (contentMatches) {
      return true;
    }

    // Attachment-only optimistic messages may be represented by backend summary
    // text (e.g. "[Uploaded Attachments: ...]"). In that case, rely on
    // timestamp + attachment/image presence to avoid duplicate user bubbles.
    if (optimisticHasVisualAttachment && hasVisualAttachmentBlock(m)) {
      return true;
    }

    return false;
  };

  const matchedIndex = nextList.findIndex(matchFn);
  if (matchedIndex < 0) {
    return [...nextList, optimisticMsg];
  }

  // Backend message matched the optimistic message.  Preserve attachment blocks
  // from the optimistic message into the backend message's raw data; otherwise
  // non-image file attachments won't be visible.
  const optimisticRaw = optimisticMsg.raw as any;
  const optimisticContent: unknown[] | undefined = optimisticRaw?.message?.content;
  if (Array.isArray(optimisticContent)) {
    const attachmentBlocks = optimisticContent.filter(
      (b: any) => b && typeof b === 'object' && b.type === 'attachment',
    );
    if (attachmentBlocks.length > 0) {
      const backendMsg = nextList[matchedIndex];
      const backendRaw = (backendMsg.raw ?? {}) as any;
      const backendContent: unknown[] = Array.isArray(backendRaw?.message?.content)
        ? backendRaw.message.content
        : Array.isArray(backendRaw?.content)
          ? backendRaw.content
          : [];
      const mergedContent = [...attachmentBlocks, ...backendContent];
      const mergedRaw = {
        ...backendRaw,
        message: { ...(backendRaw?.message ?? {}), content: mergedContent },
      };
      const result = [...nextList];
      result[matchedIndex] = { ...backendMsg, raw: mergedRaw };
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
  // Guard: do not merge identity across different streaming turns
  // Block when either side has __turnId and they differ
  if ((prevAssistant.__turnId !== undefined || nextAssistant.__turnId !== undefined) &&
      prevAssistant.__turnId !== nextAssistant.__turnId) {
    return nextList;
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
 */
export const preserveStreamingAssistantContent = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  isStreamingRef: MutableRefObject<boolean>,
  streamingContentRef: MutableRefObject<string>,
  findLastAssistantIndex: (messages: ClaudeMessage[]) => number,
  patchAssistantForStreaming: (msg: ClaudeMessage) => ClaudeMessage,
): ClaudeMessage[] => {
  if (!isStreamingRef.current) return nextList;

  const prevAssistantIdx = findLastAssistantIndex(prevList);
  const nextAssistantIdx = findLastAssistantIndex(nextList);
  if (prevAssistantIdx < 0 || nextAssistantIdx < 0) return nextList;

  const prevAssistant = prevList[prevAssistantIdx];
  const nextAssistant = nextList[nextAssistantIdx];
  if (prevAssistant.type !== 'assistant' || nextAssistant.type !== 'assistant') {
    return nextList;
  }

  // Guard: do not merge content across different streaming turns
  // Block when either side has __turnId and they differ
  if ((prevAssistant.__turnId !== undefined || nextAssistant.__turnId !== undefined) &&
      prevAssistant.__turnId !== nextAssistant.__turnId) {
    return nextList;
  }

  const previousContent = prevAssistant.content || '';
  const bufferedContent = streamingContentRef.current || '';
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
  });
  return copy;
};

const getMessageContentArray = (message: ClaudeMessage): ClaudeContentOrResultBlock[] => {
  const raw = message.raw;
  if (!raw || typeof raw !== 'object') return [];

  const content = Array.isArray(raw.message?.content)
    ? raw.message.content
    : Array.isArray(raw.content)
      ? raw.content
      : [];

  return content.filter((entry): entry is ClaudeContentOrResultBlock => Boolean(entry) && typeof entry === 'object');
};

const getToolEventKey = (block: ClaudeContentOrResultBlock): string | null => {
  if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
    return `tool_use:${block.id}`;
  }
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
    return `tool_result:${block.tool_use_id}`;
  }
  return null;
};

const getMessageToolEventKeys = (message: ClaudeMessage): string[] => {
  const keys = new Set<string>();
  for (const block of getMessageContentArray(message)) {
    const key = getToolEventKey(block);
    if (key) {
      keys.add(key);
    }
  }
  return [...keys];
};

const isToolOnlyMessage = (message: ClaudeMessage): boolean => {
  if (typeof message.content === 'string' && message.content.trim()) {
    return false;
  }
  const blocks = getMessageContentArray(message);
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool_use' || block.type === 'tool_result');
};

export const stripDuplicateTrailingToolMessages = (
  nextList: ClaudeMessage[],
  provider: string,
): ClaudeMessage[] => {
  if (provider !== 'codex') return nextList;
  if (nextList.length === 0) return nextList;

  // Pre-compute keys per message once, then use a reference-count map so we
  // can walk backwards from the tail in O(n) total instead of rebuilding a
  // Set on every iteration.
  const allKeys = nextList.map((msg) => getMessageToolEventKeys(msg));
  const keyCounts = new Map<string, number>();
  for (const keys of allKeys) {
    for (const key of keys) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }

  let endIndex = nextList.length;
  while (endIndex > 0) {
    const lastMessage = nextList[endIndex - 1];
    if (!isToolOnlyMessage(lastMessage)) break;

    const candidateKeys = allKeys[endIndex - 1];
    if (candidateKeys.length === 0) break;

    // A key is duplicated if it appears more than once across all remaining messages.
    if (!candidateKeys.every((key) => (keyCounts.get(key) ?? 0) > 1)) {
      break;
    }

    // Decrement counts for the removed message's keys.
    for (const key of candidateKeys) {
      const count = keyCounts.get(key) ?? 0;
      if (count <= 1) {
        keyCounts.delete(key);
      } else {
        keyCounts.set(key, count - 1);
      }
    }

    endIndex--;
  }

  return endIndex === nextList.length ? nextList : nextList.slice(0, endIndex);
};

/**
 * When backend snapshots briefly shrink (e.g., Codex compaction or Claude
 * conversation summarization), preserve the newest in-memory turn locally
 * until the backend catches up, instead of wiping it from the UI.
 * FIX: Apply to all providers, not just Codex, to prevent message loss
 * during streaming end race conditions.
 */
export const preserveLatestMessagesOnShrink = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  provider: string,
): ClaudeMessage[] => {
  // Always check for shrink regardless of provider
  if (nextList.length >= prevList.length) return nextList;
  if (prevList.length === 0 || nextList.length === 0) return nextList;

  const preservedTail = prevList.slice(nextList.length);
  if (preservedTail.length === 0) return nextList;

  // Check if the preserved tail contains streaming/recent assistant messages
  const hasStreamingTail = preservedTail.some((msg) => msg.type === 'assistant' && (msg.isStreaming || !!msg.__turnId));
  const hasRecentUserTail = preservedTail.some((msg) => msg.type === 'user');

  // Codex: always preserve shrink tail (handles compaction/summarization)
  // Other providers: only preserve if tail contains streaming/recent messages
  if (provider !== 'codex' && !hasStreamingTail && !hasRecentUserTail) {
    return nextList;
  }

  return [...nextList, ...preservedTail];
};

// ---------------------------------------------------------------------------
// Streaming assistant preservation
// ---------------------------------------------------------------------------

/**
 * Ensure a streaming assistant message is not lost when updateMessages replaces
 * the entire message list.  Returns the (possibly amended) result list and the
 * index of the streaming assistant inside it.
 *
 * The function has two paths:
 * 1. Primary — refs are valid (normal streaming).
 * 2. Fallback — refs already cleared (race condition). Uses message-level
 *    `isStreaming` + `__turnId` markers to recover.
 */
export const ensureStreamingAssistantInList = (
  prevList: ClaudeMessage[],
  resultList: ClaudeMessage[],
  isStreaming: boolean,
  streamingTurnId: number,
): { list: ClaudeMessage[]; streamingIndex: number } => {
  // Primary path: refs are still valid
  if (isStreaming && streamingTurnId > 0) {
    const existingIdx = resultList.findIndex(
      (m) => m.__turnId === streamingTurnId && m.type === 'assistant',
    );
    if (existingIdx >= 0) {
      return { list: resultList, streamingIndex: existingIdx };
    }

    let streamingAssistant: ClaudeMessage | undefined;
    for (let i = prevList.length - 1; i >= 0; i--) {
      if (prevList[i].__turnId === streamingTurnId && prevList[i].type === 'assistant') {
        streamingAssistant = prevList[i];
        break;
      }
    }

    if (streamingAssistant) {
      const result = [...resultList, streamingAssistant];
      return { list: result, streamingIndex: result.length - 1 };
    }

    return { list: resultList, streamingIndex: -1 };
  }

  // Fallback path: refs already cleared (race condition).
  // Only consider the most recent streaming assistant in prevList.
  for (let i = prevList.length - 1; i >= 0; i--) {
    const msg = prevList[i];
    if (msg.type === 'assistant' && msg.isStreaming && msg.__turnId && msg.__turnId > 0) {
      const alreadyPresent = resultList.some((m) => {
        if (m.type !== 'assistant') return false;
        if (m.__turnId === msg.__turnId) return true;
        if (msg.timestamp && m.timestamp === msg.timestamp) return true;
        return false;
      });
      const assistantAlreadyAtOrAfterPosition =
        i < resultList.length && resultList.slice(i).some((m) => m.type === 'assistant');

      if (!alreadyPresent && !assistantAlreadyAtOrAfterPosition) {
        const result = [...resultList, msg];
        return { list: result, streamingIndex: result.length - 1 };
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
