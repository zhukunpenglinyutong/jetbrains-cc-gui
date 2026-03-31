/**
 * messageCallbacks.ts
 *
 * Registers window bridge callbacks for message management:
 * updateMessages, updateStatus, showLoading, showThinkingStatus,
 * setHistoryData, clearMessages, addErrorMessage, addHistoryMessage,
 * historyLoadComplete, addUserMessage.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';
import type { ContentBlock } from '../../useStreamingMessages';
import { sendBridgeEvent } from '../../../utils/bridge';
import {
  appendOptimisticMessageIfMissing,
  ensureStreamingAssistantInList,
  getRawUuid,
  normalizeStreamingNewlines,
  preserveLastAssistantIdentity,
  preserveLatestMessagesOnShrink,
  preserveStreamingAssistantContent,
} from '../messageSync';
import { releaseSessionTransition } from '../sessionTransition';

const isTruthy = (v: unknown) => v === true || v === 'true';

/**
 * Pre-compiled regex for collapsing whitespace sequences during streaming value comparison.
 * Hoisted to module level to avoid per-call RegExp object creation (js-hoist-regexp).
 * Safe to reuse with String.prototype.replace which does not depend on lastIndex.
 */
const WHITESPACE_COLLAPSE_RE = /\s+/g;

/**
 * Combined single-pass extraction of canonical text and thinking from backend blocks.
 * Avoids iterating the blocks array twice (js-combine-array-iterations).
 */
const extractCanonicalContent = (blocks: ContentBlock[]): { text: string; thinking: string } => {
  let text = '';
  let thinking = '';
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      // Runtime guard retained for defensive safety against SDK bridge data (N2).
      const t = (block as Record<string, unknown>).text;
      if (typeof t === 'string') text += t;
    } else if (block.type === 'thinking') {
      const b = block as Record<string, unknown>;
      if (typeof b.thinking === 'string') thinking += b.thinking;
      else if (typeof b.text === 'string') thinking += b.text as string;
    }
  }
  return { text, thinking: normalizeStreamingNewlines(thinking) };
};

/** Extract canonical text from backend blocks. Thin wrapper over extractCanonicalContent. */
const extractCanonicalTextFromBlocks = (blocks: ContentBlock[]): string =>
  extractCanonicalContent(blocks).text;

/** Extract canonical thinking text from backend blocks (checks both `thinking` and `text` fields). */
const extractCanonicalThinkingFromBlocks = (blocks: ContentBlock[]): string =>
  extractCanonicalContent(blocks).thinking;

/**
 * Choose the more complete streaming value between current and candidate.
 *
 * Used ONLY during streaming to detect same-length mutations (e.g., typo fixes)
 * and prefer longer content. DO NOT use for non-streaming message merges.
 *
 * Selection priority:
 * 1. If candidate is empty, keep current (preserve existing content)
 * 2. If current is empty, use candidate (adopt new content)
 * 3. If candidate is longer, use candidate (more complete content)
 * 4. If same length but different content, use candidate only if it has
 *    meaningful character differences (not just whitespace/formatting changes)
 * 5. Otherwise, keep current (identical content)
 *
 * Note: Same-length different content checks for meaningful changes because:
 * - Backend may correct typos without changing length (e.g., "axc" -> "abc")
 * - Whitespace-only changes (e.g., "hello world" -> "hello  world") are less
 *   likely to be intentional corrections and may cause visual flicker
 * - This ensures UI shows the most accurate version while avoiding unnecessary updates
 */
const chooseMoreCompleteStreamingValue = (currentValue: string, candidateValue: string): string => {
  if (!candidateValue) return currentValue;
  if (!currentValue) return candidateValue;
  if (candidateValue.length > currentValue.length) return candidateValue;
  if (candidateValue.length === currentValue.length && candidateValue !== currentValue) {
    // Check if the difference is meaningful (not just whitespace/formatting)
    const currentTrimmed = currentValue.replace(WHITESPACE_COLLAPSE_RE, ' ').trim();
    const candidateTrimmed = candidateValue.replace(WHITESPACE_COLLAPSE_RE, ' ').trim();
    // Only switch if trimmed content differs (indicates real content change, not formatting)
    if (candidateTrimmed !== currentTrimmed) {
      return candidateValue;
    }
    // Whitespace-only difference: keep current to avoid visual flicker
    return currentValue;
  }
  return currentValue;
};

/**
 * Select the most complete text from multiple streaming sources.
 * Delegates pairwise comparison to `chooseMoreCompleteStreamingValue` to avoid
 * duplicating the whitespace-collapse / same-length heuristic.
 *
 * Implicit priority when candidates have equal length: the LAST candidate with a
 * meaningful difference wins. Because candidates are collected in order
 * [streamingContent, assistantContent, backendText], backendText receives the
 * highest implicit priority — which is correct since the backend is the most
 * authoritative source.
 */
const selectMostCompleteStreamingText = (
  streamingContent: string,
  assistantContent: string,
  backendText: string,
): string => {
  // Fast path: single non-empty source (common during early streaming — js-early-exit)
  if (!assistantContent && !backendText) return streamingContent || '';
  if (!streamingContent && !backendText) return assistantContent || '';
  if (!streamingContent && !assistantContent) return backendText || '';

  // Pairwise reduction — order matters: later candidates win on tie (implicit priority).
  // chooseMoreCompleteStreamingValue(current, candidate) keeps current when candidate
  // is empty or shorter, and prefers candidate on same-length meaningful difference.
  let best = streamingContent || '';
  if (assistantContent) best = chooseMoreCompleteStreamingValue(best, assistantContent);
  if (backendText) best = chooseMoreCompleteStreamingValue(best, backendText);
  return best;
};

/**
 * Result of canonical streaming state computation.
 * Separated from ref mutation so the caller can apply ref updates outside the state updater.
 */
interface CanonicalStreamingResult {
  assistant: ClaudeMessage;
  nextText: string;
  nextThinking: string;
  /** Pre-extracted blocks from the assistant, returned to avoid redundant extraction. */
  blocks: ContentBlock[];
}

/**
 * Compute the canonical streaming state from backend blocks and snapshotted ref values.
 * This is a PURE computation — it accepts plain values (not refs) to guarantee
 * idempotent results under React StrictMode double-invocation.
 *
 * Accepts pre-extracted `blocks` to avoid redundant `extractRawBlocks` calls on the
 * hot streaming reconciliation path (I3: js-combine-iterations).
 *
 * Callers MUST snapshot ref values BEFORE the state updater and pass those snapshots here.
 */
const computeCanonicalStreamingState = (
  assistant: ClaudeMessage,
  blocks: ContentBlock[],
  snapshotStreamingContent: string,
  snapshotThinkingContent: string,
): CanonicalStreamingResult => {
  const { text: backendText, thinking: backendThinking } = extractCanonicalContent(blocks);

  // Use clear priority-based selection for text
  const nextText = selectMostCompleteStreamingText(
    snapshotStreamingContent,
    assistant.content || '',
    backendText,
  );

  // For thinking, use simpler comparison since we only have two sources
  const currentThinking = normalizeStreamingNewlines(snapshotThinkingContent);
  const nextThinking = chooseMoreCompleteStreamingValue(currentThinking, backendThinking);

  return {
    assistant: {
      ...assistant,
      content: nextText,
    },
    nextText,
    nextThinking,
    blocks,
  };
};

/**
 * Fast djb2-style string hash for structural comparison of thinking block content.
 * Iterates the full string to guarantee that changes in any position are detected.
 * Returns a 32-bit unsigned integer as a hex string.
 */
const djb2Hash = (str: string): string => {
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  // eslint-disable-next-line no-bitwise
  return (hash >>> 0).toString(16);
};

/**
 * Generate a content hash for structural block signature comparison.
 * Uses djb2 hash of the full content + length to reliably detect changes
 * in any part of the content, avoiding the sampling blind spots
 * of prefix/suffix approaches. For short content (<=100 chars), the full
 * text is included directly to preserve human readability in debug output.
 *
 * Applied to both thinking and text blocks to avoid creating large temporary
 * strings on the hot streaming reconciliation path (GC pressure reduction).
 */
const getContentHash = (content: string): string => {
  if (!content) return 'empty';
  if (content.length <= 100) return `${content.length}:${content}`;
  return `${content.length}:${djb2Hash(content)}`;
};

const getStructuralBlockSignature = (block: ContentBlock | null | undefined): string => {
  if (!block || typeof block !== 'object') return 'invalid';

  // Cast to Record for uniform property access — all accesses use typeof guards below.
  const b = block as Record<string, unknown>;
  const type = typeof b.type === 'string' ? b.type : 'unknown';
  // Use string template instead of JSON.stringify for the four common block types
  // to avoid serialization overhead on the hot streaming reconciliation path.
  switch (type) {
    case 'thinking': {
      // Fall back to b.text for legacy/variant formats (consistent with extractCanonicalThinkingFromBlocks).
      const sig = typeof b.signature === 'string' ? b.signature : '';
      const content = typeof b.thinking === 'string' ? (b.thinking as string) :
        typeof b.text === 'string' ? (b.text as string) : '';
      return `thinking|${sig}|${getContentHash(content)}`;
    }
    case 'text': {
      const text = typeof b.text === 'string' ? (b.text as string) : '';
      return `text|${getContentHash(text)}`;
    }
    case 'tool_use':
      return `tool_use|${typeof b.id === 'string' ? b.id : ''}|${typeof b.name === 'string' ? b.name : ''}`;
    case 'tool_result':
      return `tool_result|${typeof b.tool_use_id === 'string' ? b.tool_use_id : ''}|${b.is_error === true}`;
    default:
      // Unknown block types: use type + key identity fields for lightweight comparison
      // instead of full JSON.stringify (N1: avoids serialization overhead).
      return `${type}|${typeof b.id === 'string' ? b.id : ''}|${typeof b.name === 'string' ? b.name : ''}`;
  }
};

const hasStructuralBlockChange = (previousBlocks: ContentBlock[], nextBlocks: ContentBlock[]): boolean => {
  // Early length check avoids expensive signature computation (js-length-check-first).
  if (previousBlocks.length !== nextBlocks.length) return true;

  // Compute signatures inline — each signature is used exactly once, so
  // creating an intermediate array via .map() is unnecessary GC pressure
  // on the hot streaming reconciliation path (I2).
  for (let i = 0; i < nextBlocks.length; i += 1) {
    if (getStructuralBlockSignature(previousBlocks[i]) !== getStructuralBlockSignature(nextBlocks[i])) {
      return true;
    }
  }

  return false;
};

const collectAssistantBlocks = (
  messages: ClaudeMessage[],
  extractBlocks: (raw: ClaudeMessage['raw']) => ContentBlock[],
): ContentBlock[] => {
  const collected: ContentBlock[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.type !== 'assistant') continue;
    const blocks = extractBlocks(message.raw);
    if (blocks.length > 0) {
      collected.push(...blocks);
    }
  }
  return collected;
};

export function registerMessageCallbacks(
  options: UseWindowCallbacksOptions,
  resetTransientUiState: () => void,
): void {
  const {
    addToast,
    setMessages,
    setStatus,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setHistoryData,
    userPausedRef,
    isUserAtBottomRef,
    messagesContainerRef,
    suppressNextStatusToastRef,
    streamingContentRef,
    isStreamingRef,
    streamingTextSegmentsRef,
    activeTextSegmentIndexRef,
    streamingThinkingSegmentsRef,
    activeThinkingSegmentIndexRef,
    seenToolUseCountRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    findLastAssistantIndex,
    extractRawBlocks,
    patchAssistantForStreaming,
  } = options;

  const ensureStreamingAssistantPreserved = (prevList: ClaudeMessage[], resultList: ClaudeMessage[]): ClaudeMessage[] => {
    const { list, streamingIndex } = ensureStreamingAssistantInList(
      prevList,
      resultList,
      isStreamingRef.current,
      streamingTurnIdRef.current,
    );
    if (streamingIndex >= 0) {
      streamingMessageIndexRef.current = streamingIndex;
    }
    return list;
  };

  // During streaming, buffer updateMessages calls and process only the latest
  // one per animation frame. This prevents JSON.parse of large payloads from
  // blocking the main thread on every coalescer push (which can arrive every
  // 50ms), eliminating the "fake freeze" symptom.
  //
  // Stored on `window` so that if registerMessageCallbacks is called again
  // (e.g., HMR, parent re-render), the previous pending rAF is cancelled
  // first — preventing stale closures from executing.
  if (window.__pendingUpdateRaf != null) {
    cancelAnimationFrame(window.__pendingUpdateRaf);
    window.__pendingUpdateRaf = null;
    window.__pendingUpdateJson = null;
  }
  let pendingUpdateJson: string | null = null;
  let pendingUpdateRaf: number | null = null;

  const processUpdateMessages = (json: string) => {
    try {
      const parsed = JSON.parse(json) as ClaudeMessage[];

      // Snapshot ref values BEFORE the state updater for the primary
      // reconciliation path (computeCanonicalStreamingState). Some intermediate
      // steps (preserveStreamingAssistantContent, seenToolUseCountRef) still
      // read refs directly — this is safe because their logic converges
      // monotonically: content selection always picks the longest value, and
      // tool-use count only increases. Ref mutations still happen inside the
      // updater (same as onStreamEnd pattern) to ensure previously queued
      // updaters still read valid refs when React processes them in enqueue order.
      const snapshotStreamingContent = streamingContentRef.current;
      const snapshotThinkingContent = streamingThinkingSegmentsRef.current.join('');

      setMessages((prev) => {
        // ── Non-streaming path ──
        if (!isStreamingRef.current) {
          // Smart merge: reuse old message objects for performance
          let smartMerged = parsed.map((newMsg, i) => {
            if (i === parsed.length - 1) return newMsg;
            if (i < prev.length) {
              const oldMsg = prev[i];
              if (
                oldMsg.timestamp === newMsg.timestamp &&
                oldMsg.type === newMsg.type &&
                oldMsg.content === newMsg.content
              ) {
                return oldMsg;
              }
            }
            return newMsg;
          });

          smartMerged = preserveLastAssistantIdentity(prev, smartMerged, findLastAssistantIndex);
          smartMerged = preserveLatestMessagesOnShrink(prev, smartMerged, options.currentProviderRef.current);
          return ensureStreamingAssistantPreserved(prev, appendOptimisticMessageIfMissing(prev, smartMerged));
        }

        // ── Streaming path ──
        const lastAssistantIdx = findLastAssistantIndex(parsed);

        // Backend snapshot has no assistant message — preserve existing streaming assistant
        if (lastAssistantIdx < 0) {
          return ensureStreamingAssistantPreserved(
            prev,
            preserveLatestMessagesOnShrink(
              prev,
              appendOptimisticMessageIfMissing(prev, parsed),
              options.currentProviderRef.current,
            ),
          );
        }

        // Determine whether the backend snapshot contains a structural change worth accepting
        const lastAssistant = parsed[lastAssistantIdx];
        const lastAssistantBlocks = extractRawBlocks(lastAssistant.raw);
        const aggregatedAssistantBlocks = collectAssistantBlocks(parsed, extractRawBlocks);
        const previousAssistantBlocks = collectAssistantBlocks(prev, extractRawBlocks);
        const toolUseCount = aggregatedAssistantBlocks.filter((b) => b?.type === 'tool_use').length;
        // Never decrease seenToolUseCountRef — stale snapshots with fewer tool_use blocks
        // must not reset the high-water mark, or a later snapshot with the original count
        // would falsely trigger hasNewToolUse again.
        const hasNewToolUse = toolUseCount > seenToolUseCountRef.current;
        const hasToolUse = toolUseCount > 0;
        const structuralBlockChanged = hasStructuralBlockChange(previousAssistantBlocks, aggregatedAssistantBlocks);

        // No meaningful structural change in the backend assistant snapshot.
        // Still accept newly arrived non-assistant messages (for example, the current
        // user message restored by Java) while preserving the active streaming assistant.
        if (!hasNewToolUse && !hasToolUse && !structuralBlockChanged) {
          let unchanged = [...parsed];
          unchanged = appendOptimisticMessageIfMissing(prev, unchanged);
          unchanged = preserveLastAssistantIdentity(prev, unchanged, findLastAssistantIndex);
          unchanged = preserveStreamingAssistantContent(
            prev,
            unchanged,
            isStreamingRef.current,
            snapshotStreamingContent,
            findLastAssistantIndex,
            patchAssistantForStreaming,
          );
          return ensureStreamingAssistantPreserved(prev, unchanged);
        }

        if (hasNewToolUse) {
          seenToolUseCountRef.current = toolUseCount;
          activeTextSegmentIndexRef.current = -1;
          activeThinkingSegmentIndexRef.current = -1;
        }

        let patched = [...parsed];
        if (patched[lastAssistantIdx]?.type === 'assistant' && streamingTurnIdRef.current > 0) {
          patched[lastAssistantIdx] = {
            ...patched[lastAssistantIdx],
            __turnId: streamingTurnIdRef.current,
          };
        }
        patched = appendOptimisticMessageIfMissing(prev, patched);
        patched = preserveLastAssistantIdentity(prev, patched, findLastAssistantIndex);
        patched = preserveStreamingAssistantContent(
          prev,
          patched,
          isStreamingRef.current,
          snapshotStreamingContent,
          findLastAssistantIndex,
          patchAssistantForStreaming,
        );
        patched = preserveLatestMessagesOnShrink(prev, patched, options.currentProviderRef.current);

        const patchedAssistantIdx = findLastAssistantIndex(patched);
        if (patchedAssistantIdx >= 0 && patched[patchedAssistantIdx]?.type === 'assistant') {
          streamingMessageIndexRef.current = patchedAssistantIdx;

          // Step 1: PURE computation — determine canonical text/thinking from
          // snapshotted ref values (captured before the updater for StrictMode safety).
          // Reuses lastAssistantBlocks extracted earlier to avoid redundant extractRawBlocks (I3).
          const result = computeCanonicalStreamingState(
            {
              ...patched[patchedAssistantIdx],
              __turnId: streamingTurnIdRef.current,
            },
            lastAssistantBlocks,
            snapshotStreamingContent,
            snapshotThinkingContent,
          );

          // Step 2: Apply computed canonical values to refs.
          // These ref writes are idempotent under StrictMode double-invocation because
          // computeCanonicalStreamingState was called with snapshotted values (not refs),
          // so result.nextText / result.nextThinking are identical across invocations.
          // Kept inside the updater (same as onStreamEnd pattern) to ensure previously
          // queued updaters still read valid refs when React processes them in enqueue order.
          streamingContentRef.current = result.nextText;
          streamingTextSegmentsRef.current = result.nextText ? [result.nextText] : [];
          activeTextSegmentIndexRef.current = result.nextText ? 0 : -1;
          streamingThinkingSegmentsRef.current = result.nextThinking ? [result.nextThinking] : [];
          activeThinkingSegmentIndexRef.current = result.nextThinking ? 0 : -1;

          // Step 3: Rebuild assistant message blocks from canonical state.
          // Uses result.blocks (pre-extracted) instead of re-calling extractRawBlocks (I3).
          patched[patchedAssistantIdx] = patchAssistantForStreaming(result.assistant, {
            canonicalText: result.nextText,
            canonicalThinking: result.nextThinking,
            existingBlocks: result.blocks,
          });
        }

        return ensureStreamingAssistantPreserved(prev, patched);
      });
    } catch (error) {
      console.error('[Frontend] Failed to parse messages:', error);
    }
  };

  window.updateMessages = (json) => {
    // During session transition, ignore message updates from stale session
    // callbacks to prevent cleared messages from being restored
    if (window.__sessionTransitioning) return;

    // FIX: Bump stream stall watchdog — receiving updateMessages proves the
    // backend→frontend bridge is alive even between content deltas (e.g.,
    // during tool execution phases where no text is produced).
    if (isStreamingRef.current && window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }

    // During streaming, coalesce rapid updateMessages calls into one-per-frame.
    // The backend coalescer may push every 50ms; JSON.parse of large payloads
    // (100KB+ for long conversations) blocks the main thread and causes dropped
    // frames ("fake freeze"). Deferring to rAF ensures we only parse the latest
    // payload and yield to the browser between frames.
    if (isStreamingRef.current) {
      pendingUpdateJson = json;
      window.__pendingUpdateJson = json;
      if (pendingUpdateRaf === null) {
        const rafId = requestAnimationFrame(() => {
          pendingUpdateRaf = null;
          window.__pendingUpdateRaf = null;
          const latestJson = pendingUpdateJson;
          pendingUpdateJson = null;
          window.__pendingUpdateJson = null;
          if (latestJson) {
            processUpdateMessages(latestJson);
          }
        });
        pendingUpdateRaf = rafId;
        window.__pendingUpdateRaf = rafId;
      }
      return;
    }

    processUpdateMessages(json);
  };

  const pendingMessages = (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
  if (typeof pendingMessages === 'string' && pendingMessages.length > 0) {
    delete (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
    window.updateMessages(pendingMessages);
  }

  window.updateStatus = (text) => {
    // Do not release the transition guard from generic status updates.
    setStatus(text);
    if (suppressNextStatusToastRef.current) {
      suppressNextStatusToastRef.current = false;
      return;
    }
    addToast(text);
  };

  window.showLoading = (value) => {
    const isLoading = isTruthy(value);

    // FIX: Ignore loading=false during streaming — onStreamEnd handles it uniformly.
    if (!isLoading && isStreamingRef.current) {
      return;
    }

    // Notify backend about loading state change for tab indicator
    sendBridgeEvent('tab_loading_changed', JSON.stringify({ loading: isLoading }));

    setLoading((prevLoading) => {
      if (isLoading) {
        if (!prevLoading) {
          setLoadingStartTime(Date.now());
        }
      } else {
        setLoadingStartTime(null);
      }
      return isLoading;
    });
  };

  window.showThinkingStatus = (value) => setIsThinking(isTruthy(value));
  window.showSummary = (summary) => {
    if (!summary || !summary.trim()) return;
    setStatus(summary);
  };
  window.setHistoryData = (data) => setHistoryData(data);

  const pendingStatus = (window as unknown as Record<string, unknown>).__pendingStatusText;
  if (typeof pendingStatus === 'string' && pendingStatus.length > 0) {
    delete (window as unknown as Record<string, unknown>).__pendingStatusText;
    window.updateStatus?.(pendingStatus);
  }

  const pendingLoading = window.__pendingLoadingState;
  if (typeof pendingLoading === 'boolean') {
    delete window.__pendingLoadingState;
    window.showLoading?.(pendingLoading);
  }

  const pendingUserMessage = window.__pendingUserMessage;
  if (typeof pendingUserMessage === 'string' && pendingUserMessage.length > 0) {
    delete window.__pendingUserMessage;
    window.addUserMessage?.(pendingUserMessage);
  }

  const pendingSummary = (window as unknown as Record<string, unknown>).__pendingSummaryText;
  if (typeof pendingSummary === 'string' && pendingSummary.length > 0) {
    delete (window as unknown as Record<string, unknown>).__pendingSummaryText;
    window.showSummary?.(pendingSummary);
  }

  window.patchMessageUuid = (content, uuid) => {
    if (window.__sessionTransitioning) return;
    if (!content || !uuid) return;

    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        const message = prev[i];
        if (message.type !== 'user') continue;
        if (getRawUuid(message)) continue;

        const rawText = extractRawBlocks(message.raw)
          .filter((block): block is ContentBlock & { type: 'text'; text: string } =>
            block?.type === 'text' && 'text' in block && typeof (block as Record<string, unknown>).text === 'string')
          .map((block) => block.text)
          .join('\n');
        if ((message.content || '') !== content && rawText !== content) continue;

        const raw: ClaudeMessage['raw'] =
          typeof message.raw === 'object' && message.raw
            ? { ...message.raw, uuid }
            : {
                uuid,
                message: {
                  content: [{ type: 'text' as const, text: message.content || content }],
                },
              };

        const next = [...prev];
        next[i] = {
          ...message,
          raw,
        };
        return next;
      }

      console.debug('[patchMessageUuid] no matching unresolved user message found for content:', content);
      return prev;
    });
  };

  window.clearMessages = () => {
    // Cancel any pending deferred updateMessages to prevent stale data from
    // being applied after messages are cleared.
    if (pendingUpdateRaf !== null) {
      cancelAnimationFrame(pendingUpdateRaf);
      pendingUpdateRaf = null;
      pendingUpdateJson = null;
      window.__pendingUpdateRaf = null;
      window.__pendingUpdateJson = null;
    }
    window.__deniedToolIds?.clear();
    resetTransientUiState();
    setMessages([]);
  };

  window.addErrorMessage = (message) => {
    addToast(message, 'error');
  };

  window.addHistoryMessage = (message: ClaudeMessage) => {
    if (window.__sessionTransitioning) return;
    setMessages((prev) => [...prev, message]);
  };

  // History load complete callback — triggers Markdown re-rendering
  window.historyLoadComplete = () => {
    releaseSessionTransition();
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1] };
      return updated;
    });
  };

  window.addUserMessage = (content: string) => {
    if (window.__sessionTransitioning) return;
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: content || '',
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.type === 'assistant' && last?.isStreaming) {
        const next = [...prev];
        next.splice(prev.length - 1, 0, userMessage);
        return next;
      }
      return [...prev, userMessage];
    });
    userPausedRef.current = false;
    isUserAtBottomRef.current = true;
    requestAnimationFrame(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    });
  };

}

// ---------------------------------------------------------------------------
// @internal — exported for direct unit testing only.
// ---------------------------------------------------------------------------
export {
  chooseMoreCompleteStreamingValue as _chooseMoreCompleteStreamingValue,
  selectMostCompleteStreamingText as _selectMostCompleteStreamingText,
  computeCanonicalStreamingState as _computeCanonicalStreamingState,
  getContentHash as _getContentHash,
  getStructuralBlockSignature as _getStructuralBlockSignature,
  hasStructuralBlockChange as _hasStructuralBlockChange,
  collectAssistantBlocks as _collectAssistantBlocks,
  extractCanonicalTextFromBlocks as _extractCanonicalTextFromBlocks,
  extractCanonicalThinkingFromBlocks as _extractCanonicalThinkingFromBlocks,
};
