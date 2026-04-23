/**
 * streamingCallbacks.ts
 *
 * Registers window bridge callbacks for streaming:
 * onStreamStart, onContentDelta, onThinkingDelta, onStreamEnd, onPermissionDenied.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { sendBridgeEvent } from '../../../utils/bridge';
import { THROTTLE_INTERVAL } from '../../useStreamingMessages';
import { parseSequence } from '../parseSequence';

/**
 * Timeout (ms) for detecting a stalled stream.  If no content/thinking delta
 * arrives for this duration while isStreamingRef is still true, the frontend
 * auto-recovers by forcing the stream-end cleanup.  This guards against the
 * backend onStreamEnd signal being silently dropped by JCEF.
 *
 * Set to 60s to avoid false positives during long tool execution phases
 * (e.g., command execution, file operations) where no content deltas arrive
 * but the backend is still actively processing.  The backend heartbeat
 * mechanism in StreamMessageCoalescer keeps __lastStreamActivityAt bumped
 * via periodic updateMessages re-pushes.
 */
const STREAM_STALL_TIMEOUT_MS = 60_000;
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
    useBackendStreamingRenderRef,
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
    getOrCreateStreamingAssistantIndex,
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
    // Clear the previous stream-ended marker when a new turn starts
    window.__lastStreamEndedTurnId = undefined;
    window.__lastStreamEndedAt = undefined;
    // Record turn start time for duration calculation in onStreamEnd
    window.__turnStartedAt = Date.now();
    streamingContentRef.current = '';
    isStreamingRef.current = true;
    startStallWatchdog();
    useBackendStreamingRenderRef.current = false;
    autoExpandedThinkingKeysRef.current.clear();
    setStreamingActive(true);
    streamingTextSegmentsRef.current = [];
    activeTextSegmentIndexRef.current = -1;
    streamingThinkingSegmentsRef.current = [];
    activeThinkingSegmentIndexRef.current = -1;
    seenToolUseCountRef.current = 0;

    // FIX: Always reset streamingMessageIndexRef regardless of backend streaming mode
    streamingMessageIndexRef.current = -1;
    turnIdCounterRef.current += 1;
    streamingTurnIdRef.current = turnIdCounterRef.current;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.type === 'assistant' && last?.isStreaming) {
        // FIX: If the last streaming assistant belongs to an OLDER turn,
        // its onStreamEnd was likely dropped (e.g., JCEF async chain
        // breakage). Finalize it (isStreaming=false) and start a fresh
        // assistant for the new turn, so new deltas are not appended
        // to the previous turn's bubble.
        const lastTurnId = (last as { __turnId?: number }).__turnId;
        const currentTurnId = streamingTurnIdRef.current;
        if (typeof lastTurnId === 'number' && lastTurnId > 0 && lastTurnId < currentTurnId) {
          const finalized = [...prev];
          finalized[prev.length - 1] = { ...last, isStreaming: false };
          streamingMessageIndexRef.current = finalized.length;
          return [
            ...finalized,
            {
              type: 'assistant',
              content: '',
              isStreaming: true,
              timestamp: new Date().toISOString(),
              __turnId: currentTurnId,
            },
          ];
        }
        streamingMessageIndexRef.current = prev.length - 1;
        const updated = [...prev];
        updated[prev.length - 1] = { ...updated[prev.length - 1], __turnId: currentTurnId };
        return updated;
      }
      streamingMessageIndexRef.current = prev.length;
      return [
        ...prev,
        {
          type: 'assistant',
          content: '',
          isStreaming: true,
          timestamp: new Date().toISOString(),
          __turnId: streamingTurnIdRef.current,
        },
      ];
    });
  };

  window.onContentDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    streamingContentRef.current += delta;
    activeThinkingSegmentIndexRef.current = -1;

    if (activeTextSegmentIndexRef.current < 0) {
      activeTextSegmentIndexRef.current = streamingTextSegmentsRef.current.length;
      streamingTextSegmentsRef.current.push('');
    }
    streamingTextSegmentsRef.current[activeTextSegmentIndexRef.current] += delta;

    const now = Date.now();
    const timeSinceLastUpdate = now - lastContentUpdateRef.current;

    const updateMessages = () => {
      const currentContent = streamingContentRef.current;
      setMessages((prev) => {
        const newMessages = [...prev];
        let idx: number;
        if (useBackendStreamingRenderRef.current) {
          idx = streamingMessageIndexRef.current;
          // Index is still -1: backend hasn't created the assistant via updateMessages yet
          if (idx < 0) return prev;
        } else {
          idx = getOrCreateStreamingAssistantIndex(newMessages);
        }

        if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
          newMessages[idx] = patchAssistantForStreaming({
            ...newMessages[idx],
            content: currentContent,
            isStreaming: true,
          });
        }
        return newMessages;
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

  window.onThinkingDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    activeTextSegmentIndexRef.current = -1;

    let forceUpdate = false;
    if (activeThinkingSegmentIndexRef.current < 0) {
      activeThinkingSegmentIndexRef.current = streamingThinkingSegmentsRef.current.length;
      streamingThinkingSegmentsRef.current.push('');
      forceUpdate = true;
    }
    streamingThinkingSegmentsRef.current[activeThinkingSegmentIndexRef.current] += delta;

    const now = Date.now();
    const timeSinceLastUpdate = now - lastThinkingUpdateRef.current;

    const updateMessages = () => {
      setMessages((prev) => {
        const newMessages = [...prev];
        let idx: number;
        if (useBackendStreamingRenderRef.current) {
          idx = streamingMessageIndexRef.current;
          if (idx < 0) return prev;
        } else {
          idx = getOrCreateStreamingAssistantIndex(newMessages);
        }

        if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
          newMessages[idx] = patchAssistantForStreaming({
            ...newMessages[idx],
            isStreaming: true,
          });
        }
        return newMessages;
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

  window.onStreamEnd = (sequence?: string | number) => {
    if (window.__sessionTransitioning) return;
    clearStallWatchdog();
    const parsedSequence = parseSequence(sequence);
    if (parsedSequence != null) {
      window.__minAcceptedUpdateSequence = Math.max(window.__minAcceptedUpdateSequence ?? 0, parsedSequence);
    }
    // Notify backend about stream completion for tab status indicator
    sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'completed' }));

    // FIX: Cancel any pending coalesced updateMessages rAF.  If onStreamEnd
    // fires between the rAF scheduling and execution, the stale snapshot
    // would be processed in the non-streaming path after refs are cleared,
    // overwriting the final state with an outdated message structure.
    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }

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

    // Snapshot turn start time BEFORE entering the updater
    const turnStartedAt = window.__turnStartedAt;
    window.__turnStartedAt = undefined;

    // Snapshot streaming state BEFORE clearing refs - used for post-stream merge guard
    const endedStreamingTurnId = streamingTurnIdRef.current;
    const endedStreamingMessageIndex = streamingMessageIndexRef.current;
    const endedStreamingContent = streamingContentRef.current;

    // FIX: Clear streaming refs BEFORE setMessages updater to prevent race conditions.
    //
    // Trade-off analysis:
    // - Original approach: refs cleared inside updater, leverages React batching to ensure
    //   clearing and state update happen together. But this caused timing issues when
    //   deferred operations (rAF, timeout) executed after the updater but before refs were
    //   actually cleared, allowing them to modify the streaming message incorrectly.
    // - New approach: refs cleared outside updater, uses snapshot values inside updater.
    //   This prevents race conditions where deferred updateMessages sees isStreamingRef=false
    //   but streamingMessageIndexRef still points to the old message.
    // - Benefit: More robust handling of async callback ordering, especially important
    //   when JCEF async chains can reorder callbacks unpredictably.
    // - Risk: Minimal, since snapshot values are used inside updater and refs are cleared
    //   synchronously before the updater is scheduled.
    //
    // Streaming state refs (isStreaming flag)
    isStreamingRef.current = false;
    useBackendStreamingRenderRef.current = false;

    // Index refs (message position tracking)
    streamingMessageIndexRef.current = -1;
    streamingTurnIdRef.current = -1;

    // Content buffer refs (text/thinking segments)
    streamingContentRef.current = '';
    streamingTextSegmentsRef.current = [];
    streamingThinkingSegmentsRef.current = [];
    activeTextSegmentIndexRef.current = -1;
    activeThinkingSegmentIndexRef.current = -1;

    // Counter and tracking refs
    seenToolUseCountRef.current = 0;
    autoExpandedThinkingKeysRef.current.clear();

    // Mark that streaming just ended - used by mergeConsecutiveAssistantMessages to
    // distinguish recently-ended streaming messages from true history messages.
    window.__lastStreamEndedTurnId = endedStreamingTurnId;
    window.__lastStreamEndedAt = Date.now();

    // Flush final content and finalize the streaming message.
    setMessages((prev) => {
      let newMessages = prev;
      const idx = endedStreamingMessageIndex;
      if (prev.length > 0 && idx >= 0 && idx < prev.length && prev[idx]?.type === 'assistant') {
        newMessages = [...prev];
        // FIX: Keep __turnId on the message for a short period to prevent
        // incorrect merging with history messages. The __turnId will be
        // removed later when history is loaded or a new turn starts.
        const finalContent = endedStreamingContent || newMessages[idx].content || '';
        // Calculate durationMs and stamp it on the assistant message
        const durationMs = (typeof turnStartedAt === 'number' && turnStartedAt > 0)
          ? Date.now() - turnStartedAt
          : undefined;
        newMessages[idx] = {
          ...newMessages[idx],
          content: finalContent,
          isStreaming: false,
          __turnId: endedStreamingTurnId, // Keep __turnId for merge guard
          ...(durationMs != null ? { durationMs } : {}),
        };
      }

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

  // Streaming heartbeat — lightweight signal from backend during tool execution
  // phases where no content deltas arrive.  Keeps the stall watchdog alive.
  window.onStreamingHeartbeat = () => {
    if (isStreamingRef.current && window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }
  };

  // Permission denied callback — marks incomplete tool calls as "interrupted"
  window.onPermissionDenied = () => {
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }

    const idsToAdd: string[] = [];

    setMessages((currentMessages) => {
      try {
        for (let i = currentMessages.length - 1; i >= 0; i--) {
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

                for (const tu of toolUses) {
                  if (!existingResultIds.has(tu.id)) {
                    idsToAdd.push(tu.id);
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

      return [...currentMessages];
    });

    for (const id of idsToAdd) {
      window.__deniedToolIds!.add(id);
    }
  };
}
