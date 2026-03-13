/**
 * streamingCallbacks.ts
 *
 * Registers window bridge callbacks for streaming:
 * onStreamStart, onContentDelta, onThinkingDelta, onStreamEnd, onPermissionDenied.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { sendBridgeEvent } from '../../../utils/bridge';
import { THROTTLE_INTERVAL } from '../../useStreamingMessages';

export function registerStreamingCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    setMessages,
    setStreamingActive,
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

  window.onStreamStart = () => {
    if (window.__sessionTransitioning) return;
    streamingContentRef.current = '';
    isStreamingRef.current = true;
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
        streamingMessageIndexRef.current = prev.length - 1;
        const updated = [...prev];
        updated[prev.length - 1] = { ...updated[prev.length - 1], __turnId: streamingTurnIdRef.current };
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

  window.onStreamEnd = () => {
    if (window.__sessionTransitioning) return;
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

    // Flush final content BEFORE marking stream as ended
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const idx = streamingMessageIndexRef.current;
      if (idx < 0 || idx >= prev.length || prev[idx]?.type !== 'assistant') {
        return prev;
      }
      const finalContent = streamingContentRef.current;
      const newMessages = [...prev];
      newMessages[idx] = {
        ...newMessages[idx],
        content: finalContent || newMessages[idx].content,
        isStreaming: false,
      };
      return newMessages;
    });

    // Mark streaming as ended AFTER flushing content
    isStreamingRef.current = false;
    useBackendStreamingRenderRef.current = false;

    if (setExpandedThinking) {
      setExpandedThinking((prev) => {
        const keys = autoExpandedThinkingKeysRef.current;
        if (keys.size === 0) return prev;
        const next = { ...prev };
        keys.forEach((key) => {
          next[key] = false;
        });
        return next;
      });
    }

    streamingMessageIndexRef.current = -1;
    streamingTurnIdRef.current = -1;
    streamingContentRef.current = '';
    streamingTextSegmentsRef.current = [];
    activeTextSegmentIndexRef.current = -1;
    streamingThinkingSegmentsRef.current = [];
    activeThinkingSegmentIndexRef.current = -1;
    seenToolUseCountRef.current = 0;
    autoExpandedThinkingKeysRef.current.clear();
    setStreamingActive(false);
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
