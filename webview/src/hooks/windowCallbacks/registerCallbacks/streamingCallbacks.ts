/**
 * streamingCallbacks.ts
 *
 * Registers window bridge callbacks for streaming:
 * onStreamStart, onContentDelta, onThinkingDelta, onStreamEnd, onPermissionDenied.
 */

import { startTransition } from 'react';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeRawMessage } from '../../../types';
import { sendBridgeEvent } from '../../../utils/bridge';
import { THROTTLE_INTERVAL } from '../../useStreamingMessages';
import { parseSequence } from '../parseSequence';
import { getStreamEndHandlingMode } from '../messageSync';

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
    streamingThinkingRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
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
    // Clear any stale pending updateMessages from previous turn.
    // This prevents onStreamEnd from using outdated snapshot data.
    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }
    // Explicit null in case the rAF already executed (clearing pendingUpdateRaf)
    // but __pendingUpdateJson was not yet cleared by the rAF callback.
    window.__pendingUpdateJson = null;
    // Clear the previous stream-ended marker when a new turn starts
    window.__lastStreamEndedTurnId = undefined;
    window.__lastStreamEndedAt = undefined;
    // Clear idempotency guard for the new turn
    window.__streamEndProcessedTurnId = undefined;
    // Record turn start time for duration calculation in onStreamEnd
    window.__turnStartedAt = Date.now();
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    isStreamingRef.current = true;
    startStallWatchdog();
    useBackendStreamingRenderRef.current = false;
    autoExpandedThinkingKeysRef.current.clear();
    setStreamingActive(true);

    // FIX: Always reset streamingMessageIndexRef regardless of backend streaming mode
    streamingMessageIndexRef.current = -1;
    turnIdCounterRef.current += 1;
    streamingTurnIdRef.current = turnIdCounterRef.current;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.type === 'assistant') {
        streamingMessageIndexRef.current = prev.length - 1;
        const updated = [...prev];
        updated[prev.length - 1] = {
          ...updated[prev.length - 1],
          isStreaming: true,
          __turnId: streamingTurnIdRef.current,
        };
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

  // rAF-scheduled streaming update: frame-aligned, avoids setTimeout jank.
  // Factory that creates a throttled scheduler bound to a specific timeoutRef +
  // lastUpdateRef pair.  patchAssistantForStreaming reads streamingContentRef /
  // streamingThinkingRef from the hook closure, so the factory only needs to
  // know which ref pair to guard against double-scheduling.
  const createStreamingRafScheduler = (
    timeoutRef: React.MutableRefObject<number | null>,
    lastUpdateRef: React.MutableRefObject<number>,
  ) => {
    const scheduleRaf = (): void => {
      if (timeoutRef.current != null) return;
      timeoutRef.current = requestAnimationFrame(() => {
        timeoutRef.current = null;
        const now = Date.now();
        const elapsed = now - lastUpdateRef.current;
        if (elapsed < THROTTLE_INTERVAL) {
          scheduleRaf(); // too soon — wait for next frame
          return;
        }
        lastUpdateRef.current = now;
        startTransition(() => {
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
        });
      });
    };
    return scheduleRaf;
  };

  const scheduleContentRaf = createStreamingRafScheduler(contentUpdateTimeoutRef, lastContentUpdateRef);
  const scheduleThinkingRaf = createStreamingRafScheduler(thinkingUpdateTimeoutRef, lastThinkingUpdateRef);

  window.onContentDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    streamingContentRef.current += delta;
    scheduleContentRaf();
  };

  window.onThinkingDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    streamingThinkingRef.current += delta;
    scheduleThinkingRaf();
  };

  window.onStreamEnd = (sequence?: string | number) => {
    if (window.__sessionTransitioning) return;

    // Idempotency guard: dual-path delivery (primary via flush callback +
    // fallback via Alarm) may send onStreamEnd twice for the same turn.
    // Only the first arrival takes effect; the second is a no-op.
    //
    // After the first onStreamEnd processes, streamingTurnIdRef is cleared to -1
    // and isStreamingRef is set to false. The second arrival sees these cleared
    // refs and should bail out. We check both conditions:
    // 1. If the current turn ID was already processed (before refs were cleared)
    // 2. If streaming is already inactive (refs were already cleared by first call)
    const currentTurnId = streamingTurnIdRef.current;
    const handlingMode = getStreamEndHandlingMode(
      options.currentProviderRef.current,
      isStreamingRef.current,
      currentTurnId,
    );
    if (currentTurnId > 0 && window.__streamEndProcessedTurnId === currentTurnId) {
      return;
    }
    if (handlingMode === 'skip') {
      // Streaming refs already cleared by a previous onStreamEnd — nothing to do
      return;
    }

    clearStallWatchdog();
    const parsedSequence = parseSequence(sequence);
    // Only update minAcceptedUpdateSequence for valid positive sequences.
    // The fallback path sends sequence=-1 which means "no sequence info" —
    // it should not participate in sequence tracking.
    if (parsedSequence != null && parsedSequence >= 0) {
      window.__minAcceptedUpdateSequence = Math.max(window.__minAcceptedUpdateSequence ?? 0, parsedSequence);
    }
    // Notify backend about stream completion for tab status indicator
    sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'completed' }));

    if (handlingMode === 'minimal') {
      if (typeof window.__cancelPendingUpdateMessages === 'function') {
        window.__cancelPendingUpdateMessages();
      }
      setStreamingActive(false);
      setLoading(false);
      setLoadingStartTime(null);
      setIsThinking(false);
      window.__streamEndProcessedTurnId = currentTurnId > 0 ? currentTurnId : undefined;
      return;
    }

    // FIX: Extract backend final snapshot from pending updateMessages BEFORE cancelling rAF.
    // The backend's final flush contains the authoritative message state (complete raw blocks).
    // If onStreamEnd cancels the rAF without processing this snapshot, the final message may
    // show incomplete content (e.g., last delta missing) or duplicated content in raw blocks.
    let backendSnapshotContent: string | undefined;
    let backendSnapshotRaw: ClaudeRawMessage | string | undefined = undefined;
    if (typeof window.__pendingUpdateJson === 'string' && window.__pendingUpdateJson.length > 0) {
      try {
        const parsed = JSON.parse(window.__pendingUpdateJson) as Array<Record<string, unknown>>;
        for (let i = parsed.length - 1; i >= 0; i--) {
          if (parsed[i]?.type === 'assistant') {
            const rawContent = parsed[i].content;
            const content = typeof rawContent === 'string' ? rawContent : '';
            if (content) {
              backendSnapshotContent = content;
              const rawVal = parsed[i].raw;
              if (rawVal != null && (typeof rawVal === 'object' || typeof rawVal === 'string')) {
                backendSnapshotRaw = rawVal as ClaudeRawMessage | string;
              }
            }
            break;
          }
        }
      } catch (error) {
        // __pendingUpdateJson is produced internally by the bridge; a parse failure
        // indicates an upstream contract violation worth surfacing for diagnosis.
        console.warn('[Frontend] Failed to parse __pendingUpdateJson on stream end:', error);
      }
    }

    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }

    // Clear pending rAF callbacks — their content is already in streamingContentRef
    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
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
    // Use the more complete content between streaming ref and backend snapshot
    const endedStreamingContent = (backendSnapshotContent && backendSnapshotContent.length > streamingContentRef.current.length)
      ? backendSnapshotContent
      : streamingContentRef.current;
    const endedBackendRaw = backendSnapshotRaw;

    // Helper to measure total text length from raw blocks (for comparing completeness).
    // Handles both object and JSON string formats of raw.
    type TextBlock = { type: 'text'; text: string };
    const hasTextBlocks = (value: unknown): value is { message: { content: TextBlock[] } } => {
      if (!value || typeof value !== 'object') return false;
      const msg = (value as { message?: unknown }).message;
      if (!msg || typeof msg !== 'object') return false;
      const content = (msg as { content?: unknown }).content;
      return Array.isArray(content);
    };
    const getTextLenFromRaw = (raw: unknown): number => {
      let parsedRaw: unknown = raw;
      if (typeof raw === 'string') {
        try {
          parsedRaw = JSON.parse(raw);
        } catch (error) {
          console.warn('[Frontend] Failed to parse raw JSON for length comparison:', error);
          return 0;
        }
      }
      if (!hasTextBlocks(parsedRaw)) return 0;
      return parsedRaw.message.content
        .filter((b): b is TextBlock => b?.type === 'text' && typeof b.text === 'string')
        .reduce((sum, b) => sum + b.text.length, 0);
    };

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

    // Content buffer refs
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
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
        // Use backend raw blocks only if they are more complete than the existing raw.
        // The backend snapshot may be from an earlier coalescer flush, so the existing
        // raw (updated by subsequent deltas) could actually be more up-to-date.
        let finalRaw = newMessages[idx].raw;
        if (endedBackendRaw != null) {
          if (getTextLenFromRaw(endedBackendRaw) >= getTextLenFromRaw(finalRaw)) {
            finalRaw = endedBackendRaw;
          }
        }
        newMessages[idx] = {
          ...newMessages[idx],
          content: finalContent,
          raw: finalRaw,
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

    // Mark this turn as processed — idempotency guard for dual-path delivery
    window.__streamEndProcessedTurnId = endedStreamingTurnId;
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
