/**
 * streamingCallbacks.ts
 *
 * Registers window bridge callbacks for streaming:
 * onStreamStart, onContentDelta, onThinkingDelta, onStreamEnd, onPermissionDenied.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { sendBridgeEvent } from '../../../utils/bridge';
import { THROTTLE_INTERVAL, clearStreamingDataRefs } from '../../useStreamingMessages';

/**
 * Timeout (ms) for detecting a stalled stream.  If no content/thinking delta
 * arrives for this duration while isStreamingRef is still true, the frontend
 * auto-recovers by forcing the stream-end cleanup.  This guards against the
 * backend onStreamEnd signal being silently dropped by JCEF.
 */
const STREAM_STALL_TIMEOUT_MS = 45_000;
const STREAM_STALL_CHECK_INTERVAL_MS = 5_000;

export function registerStreamingCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    setMessages,
    setStreamingActive,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setExpandedThinking,
    streamingContentRef,
    isStreamingRef,
    autoExpandedThinkingKeysRef,
    streamingTextSegmentsRef,
    activeTextSegmentIndexRef,
    streamingThinkingSegmentsRef,
    activeThinkingSegmentIndexRef,
    seenToolUseCountRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    turnIdCounterRef,
    lastContentUpdateRef,
    contentUpdateTimeoutRef,
    lastThinkingUpdateRef,
    thinkingUpdateTimeoutRef,
    findStreamingAssistantIndex,
    patchAssistantForStreaming,
  } = options;

  // ── Stream stall watchdog ──
  // Tracks the last time we received any streaming activity (delta or
  // updateMessages during streaming).  A periodic check auto-recovers
  // if the backend's onStreamEnd signal was silently lost.
  // Exposed on window so messageCallbacks can also bump this on updateMessages.
  //
  // The interval handle is stored on `window` so that if registerStreamingCallbacks
  // is called again (e.g., HMR, parent re-render), the previous interval is
  // cleared first — preventing multiple watchdogs from running simultaneously.
  if (window.__stallWatchdogInterval != null) {
    clearInterval(window.__stallWatchdogInterval);
    window.__stallWatchdogInterval = null;
  }
  window.__lastStreamActivityAt = 0;

  const clearStallWatchdog = () => {
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  };

  const startStallWatchdog = () => {
    clearStallWatchdog();
    window.__lastStreamActivityAt = Date.now();
    window.__stallWatchdogInterval = setInterval(() => {
      if (!isStreamingRef.current) {
        clearStallWatchdog();
        return;
      }
      const elapsed = Date.now() - (window.__lastStreamActivityAt ?? 0);
      if (elapsed >= STREAM_STALL_TIMEOUT_MS) {
        console.warn(
          `[StreamWatchdog] Stream stalled for ${elapsed}ms — forcing stream-end recovery`,
        );
        clearStallWatchdog();
        // Trigger the same cleanup as onStreamEnd
        if (typeof window.onStreamEnd === 'function') {
          window.onStreamEnd();
        }
      }
    }, STREAM_STALL_CHECK_INTERVAL_MS);
  };

  window.onStreamStart = () => {
    if (window.__sessionTransitioning) return;
    startStallWatchdog();

    // Reset all streaming data refs via shared utility to stay in sync with
    // onStreamEnd and resetStreamingState (avoids consistency drift if new
    // refs are added to clearStreamingDataRefs in the future).
    clearStreamingDataRefs({
      streamingContentRef,
      streamingTextSegmentsRef,
      activeTextSegmentIndexRef,
      streamingThinkingSegmentsRef,
      activeThinkingSegmentIndexRef,
      seenToolUseCountRef,
      streamingMessageIndexRef,
      streamingTurnIdRef,
      autoExpandedThinkingKeysRef,
    });

    // Override values that differ from the "cleared" defaults for stream start.
    isStreamingRef.current = true;
    setStreamingActive(true);
    turnIdCounterRef.current += 1;
    streamingTurnIdRef.current = turnIdCounterRef.current;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.type === 'assistant' && last?.isStreaming) {
        streamingMessageIndexRef.current = prev.length - 1;
        const updated = [...prev];
        updated[prev.length - 1] = { ...updated[prev.length - 1], __turnId: streamingTurnIdRef.current };
        return updated;
      }

      const placeholder: typeof prev[number] = {
        type: 'assistant',
        content: '',
        isStreaming: true,
        timestamp: new Date().toISOString(),
        __turnId: streamingTurnIdRef.current,
      };

      streamingMessageIndexRef.current = prev.length;
      return [...prev, placeholder];
    });
  };

  window.onContentDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    // SAFETY: Check if streaming ended (early-clear protection from onStreamEnd)
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    streamingContentRef.current += delta;

    // NOTE: No mutual-exclusion reset of activeThinkingSegmentIndexRef here.
    // Under the single-thinking-block-per-turn design (Decision 3), thinking deltas
    // always precede text deltas within a turn, so they cannot interleave. Both
    // segment arrays accumulate independently and are merged by buildStreamingBlocks
    // at render time. If the bridge later supports interleaved thinking/text, the
    // segment arrays will still hold valid accumulated content without data loss.

    if (activeTextSegmentIndexRef.current < 0) {
      activeTextSegmentIndexRef.current = 0;
      streamingTextSegmentsRef.current = [streamingContentRef.current];
    } else {
      streamingTextSegmentsRef.current[activeTextSegmentIndexRef.current] = streamingContentRef.current;
    }

    const now = Date.now();
    const timeSinceLastUpdate = now - lastContentUpdateRef.current;

    const updateMessages = () => {
      const currentContent = streamingContentRef.current;
      const currentThinking = streamingThinkingSegmentsRef.current.join('');
      setMessages((prev) => {
        const idx = findStreamingAssistantIndex(prev);

        if (idx >= 0 && idx < prev.length && prev[idx]?.type === 'assistant') {
          const patched = patchAssistantForStreaming(
            {
              ...prev[idx],
              content: currentContent,
              isStreaming: true,
            },
            {
              canonicalText: currentContent,
              canonicalThinking: currentThinking,
            },
          );
          const newMessages = [...prev];
          newMessages[idx] = patched;
          return newMessages;
        }
        return prev;
      });
    };

    if (timeSinceLastUpdate >= THROTTLE_INTERVAL) {
      lastContentUpdateRef.current = now;
      updateMessages();
    } else {
      if (!contentUpdateTimeoutRef.current) {
        const remainingTime = THROTTLE_INTERVAL - timeSinceLastUpdate;
        contentUpdateTimeoutRef.current = setTimeout(() => {
          contentUpdateTimeoutRef.current = null;
          lastContentUpdateRef.current = Date.now();
          updateMessages();
        }, remainingTime);
      }
    }
  };

  /**
   * Handle thinking content delta during streaming.
   *
   * IMPORTANT: This implementation follows Decision 3 from design.md - single thinking block per turn.
   * The segment management assumes only ONE active thinking segment at any time.
   * This is safe because the bridge/frontend contract does not provide block-level lifecycle signals,
   * so we cannot reliably detect multiple thinking blocks from delta-type switching alone.
   *
   * If the bridge later exposes explicit thinking-block-start events, this logic will need extension
   * to support multiple thinking segments per turn.
   */
  window.onThinkingDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();

    // NOTE: No mutual-exclusion reset of activeTextSegmentIndexRef here.
    // See onContentDelta comment — thinking and text accumulate independently.

    let forceUpdate = false;
    // Single-block mode: reset to single segment array when starting new thinking
    if (activeThinkingSegmentIndexRef.current < 0) {
      activeThinkingSegmentIndexRef.current = 0;
      streamingThinkingSegmentsRef.current = [''];
      forceUpdate = true;
    }
    streamingThinkingSegmentsRef.current[activeThinkingSegmentIndexRef.current] += delta;

    const now = Date.now();
    const timeSinceLastUpdate = now - lastThinkingUpdateRef.current;

    const updateMessages = () => {
      const currentThinking = streamingThinkingSegmentsRef.current.join('');
      const currentContent = streamingContentRef.current;
      setMessages((prev) => {
        const idx = findStreamingAssistantIndex(prev);

        if (idx >= 0 && idx < prev.length && prev[idx]?.type === 'assistant') {
          const patched = patchAssistantForStreaming(
            {
              ...prev[idx],
              content: currentContent,
              isStreaming: true,
            },
            {
              canonicalText: currentContent,
              canonicalThinking: currentThinking,
            },
          );
          const newMessages = [...prev];
          newMessages[idx] = patched;
          return newMessages;
        }
        return prev;
      });
    };

    if (forceUpdate || timeSinceLastUpdate >= THROTTLE_INTERVAL) {
      lastThinkingUpdateRef.current = now;
      updateMessages();
    } else {
      if (!thinkingUpdateTimeoutRef.current) {
        const remainingTime = THROTTLE_INTERVAL - timeSinceLastUpdate;
        thinkingUpdateTimeoutRef.current = setTimeout(() => {
          thinkingUpdateTimeoutRef.current = null;
          lastThinkingUpdateRef.current = Date.now();
          updateMessages();
        }, remainingTime);
      }
    }
  };

  window.onStreamEnd = () => {
    if (window.__sessionTransitioning) return;
    clearStallWatchdog();

    // SAFETY: Mark streaming as ending immediately to prevent late delta callbacks
    // from interfering with the cleanup process. This flag is checked by delta handlers.
    isStreamingRef.current = false; // Early clear to block new deltas

    // Notify backend about stream completion for tab status indicator
    sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'completed' }));

    // Clear pending throttle timeouts — their content is already in streamingContentRef
    if (contentUpdateTimeoutRef.current) {
      clearTimeout(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current) {
      clearTimeout(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }

    // Snapshot keys that need collapsing BEFORE they are cleared inside the updater.
    const keysToCollapse = new Set(autoExpandedThinkingKeysRef.current);

    // Snapshot final content and index BEFORE clearing refs for StrictMode safety.
    // Under double-invocation, clearStreamingDataRefs resets streamingMessageIndexRef
    // to -1 on the first call, so the second call would see an invalid index.
    // By snapshotting here, both invocations use the same correct values.
    const finalIdx = streamingMessageIndexRef.current;
    const finalContentSnapshot = streamingContentRef.current;
    const finalThinkingSnapshot = streamingThinkingSegmentsRef.current.join('');

    // Flush final content AND clear streaming refs inside the same updater.
    // This ensures any previously queued setMessages updater (e.g. from
    // updateMessages) still reads valid refs when it executes, because React
    // processes updaters in enqueue order.
    setMessages((prev) => {
      let newMessages = prev;
      const idx = finalIdx;
      if (prev.length > 0 && idx >= 0 && idx < prev.length && prev[idx]?.type === 'assistant') {
        newMessages = [...prev];
        const flushedAssistant = patchAssistantForStreaming({
          ...newMessages[idx],
          content: finalContentSnapshot || newMessages[idx].content,
          isStreaming: true,
        }, {
          canonicalText: finalContentSnapshot || newMessages[idx].content || '',
          canonicalThinking: finalThinkingSnapshot,
        });
        newMessages[idx] = {
          ...flushedAssistant,
          isStreaming: false,
        };
      }

      // Clear all streaming refs AFTER flushing content, inside the updater.
      //
      // INTENTIONAL SIDE EFFECT — this is an exception to the "updaters should be pure"
      // rule. Refs are cleared here (not after setMessages) because:
      // 1. React processes updaters in enqueue order, so a previously queued
      //    updateMessages updater still reads valid refs when it executes.
      // 2. Clearing refs after setMessages would create a window where delta callbacks
      //    (blocked by isStreamingRef=false) could still see stale ref values if React
      //    batches a second state update between setMessages and the cleanup code.
      // 3. All mutations here are idempotent, so double-invocation (e.g., React StrictMode)
      //    is safe.
      //
      // TODO(react-19): Verify this pattern remains safe under React 19 concurrent mode.
      // React 19 may discard updater results in certain concurrent transitions, which
      // could skip the ref-clearing side effect. Monitor React changelog for changes
      // to updater purity guarantees.
      clearStreamingDataRefs({
        streamingContentRef,
        streamingTextSegmentsRef,
        activeTextSegmentIndexRef,
        streamingThinkingSegmentsRef,
        activeThinkingSegmentIndexRef,
        seenToolUseCountRef,
        streamingMessageIndexRef,
        streamingTurnIdRef,
        autoExpandedThinkingKeysRef,
      });

      return newMessages;
    });

    // Collapse auto-expanded thinking blocks using the pre-clear snapshot
    if (setExpandedThinking && keysToCollapse.size > 0) {
      setExpandedThinking((prev) => {
        const next = { ...prev };
        keysToCollapse.forEach((key) => {
          next[key] = false;
        });
        return next;
      });
    }

    // React state (not ref) — React batches this with setMessages automatically
    setStreamingActive(false);

    // FIX: onStreamEnd is the authoritative signal that streaming has ended.
    // Reset loading state here to prevent race conditions where showLoading("false")
    // arrives before onStreamEnd and gets ignored by the isStreamingRef guard,
    // while the flush callback's showLoading("false") may be delayed or lost
    // (e.g., due to slow message serialization or multi-hop async chains).
    setLoading(false);
    setLoadingStartTime(null);
    setIsThinking(false);
  };

  // Permission denied callback — marks incomplete tool calls as "interrupted"
  window.onPermissionDenied = () => {
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }

    setMessages((currentMessages) => {
      let changed = false;
      try {
        for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
          const msg = currentMessages[i];
          if (msg.type === 'assistant' && msg.raw) {
            const rawObj = typeof msg.raw === 'string' ? JSON.parse(msg.raw) : msg.raw;
            const content = rawObj.content || rawObj.message?.content;

            if (Array.isArray(content)) {
              const toolUses = content.filter(
                (block: { type?: string; id?: string }) =>
                  block.type === 'tool_use' && block.id,
              ) as Array<{ type: string; id: string; name?: string }>;

              if (toolUses.length > 0) {
                const nextMsg = currentMessages[i + 1];
                const existingResultIds = new Set<string>();

                if (nextMsg?.type === 'user' && nextMsg.raw) {
                  const nextRaw =
                    typeof nextMsg.raw === 'string' ? JSON.parse(nextMsg.raw) : nextMsg.raw;
                  const nextContent = nextRaw.content || nextRaw.message?.content;
                  if (Array.isArray(nextContent)) {
                    nextContent.forEach((block: { type?: string; tool_use_id?: string }) => {
                      if (block.type === 'tool_result' && block.tool_use_id) {
                        existingResultIds.add(block.tool_use_id);
                      }
                    });
                  }
                }

                // Add denied IDs inside the updater to ensure atomicity with
                // message state — avoids the race where React 18 batching defers
                // the updater execution past the old for-loop that ran after setMessages.
                for (let j = 0; j < toolUses.length; j += 1) {
                  if (!existingResultIds.has(toolUses[j].id)) {
                    window.__deniedToolIds!.add(toolUses[j].id);
                    changed = true;
                  }
                }

                break;
              }
            }
          }
        }
      } catch (e) {
        console.error('[Frontend] Error in onPermissionDenied:', e);
      }

      // Only create new array reference when denied IDs were added, to avoid
      // unnecessary React re-renders (rerender-functional-setstate).
      return changed ? [...currentMessages] : currentMessages;
    });
  };
}
