import { useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { MutableRefObject, RefObject } from 'react';
import type { ClaudeMessage, ClaudeRawMessage, HistoryData } from '../types';
import type { PermissionMode, SelectedAgent } from '../components/ChatInputBox/types';
import type { ProviderConfig } from '../types/provider';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';
import type { PlanApprovalRequest } from '../components/PlanApprovalDialog';
import type { RewindRequest } from '../components/RewindDialog';
import { THROTTLE_INTERVAL } from './useStreamingMessages';
import { sendBridgeEvent } from '../utils/bridge';
import { setupSlashCommandsCallback, resetSlashCommandsState, resetFileReferenceState } from '../components/ChatInputBox/providers';
import { downloadJSON } from '../utils/exportMarkdown';

// Performance optimization constants
/**
 * Time window (in milliseconds) for matching optimistic messages with backend messages.
 * If a user message arrives from backend within this window after an optimistic message,
 * they are considered the same message.
 */
const OPTIMISTIC_MESSAGE_TIME_WINDOW = 5000;

const isTruthy = (value: unknown) => value === true || value === 'true';

export interface ContextInfo {
  file: string;
  startLine?: number;
  endLine?: number;
  raw: string;
}

export interface UseWindowCallbacksOptions {
  t: TFunction;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;

  // State setters
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  setExpandedThinking?: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;
  setHistoryData: React.Dispatch<React.SetStateAction<HistoryData | null>>;
  setCurrentSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setUsagePercentage: React.Dispatch<React.SetStateAction<number>>;
  setUsageUsedTokens: React.Dispatch<React.SetStateAction<number | undefined>>;
  setUsageMaxTokens: React.Dispatch<React.SetStateAction<number | undefined>>;
  setPermissionMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  setClaudePermissionMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  setSelectedClaudeModel: React.Dispatch<React.SetStateAction<string>>;
  setSelectedCodexModel: React.Dispatch<React.SetStateAction<string>>;
  setProviderConfigVersion: React.Dispatch<React.SetStateAction<number>>;
  setActiveProviderConfig: React.Dispatch<React.SetStateAction<ProviderConfig | null>>;
  setClaudeSettingsAlwaysThinkingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingEnabledSetting: React.Dispatch<React.SetStateAction<boolean>>;
  setSendShortcut: React.Dispatch<React.SetStateAction<'enter' | 'cmdEnter'>>;
  setAutoOpenFileEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setSdkStatus: React.Dispatch<React.SetStateAction<Record<string, { installed?: boolean; status?: string }>>>;
  setSdkStatusLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setIsRewinding: (loading: boolean) => void;
  setRewindDialogOpen: (open: boolean) => void;
  setCurrentRewindRequest: (request: RewindRequest | null) => void;
  setContextInfo: React.Dispatch<React.SetStateAction<ContextInfo | null>>;
  setSelectedAgent: React.Dispatch<React.SetStateAction<SelectedAgent | null>>;

  // Refs
  currentProviderRef: MutableRefObject<string>;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  isUserAtBottomRef: MutableRefObject<boolean>;
  suppressNextStatusToastRef: MutableRefObject<boolean>;

  // Streaming refs from useStreamingMessages
  streamingContentRef: MutableRefObject<string>;
  isStreamingRef: MutableRefObject<boolean>;
  useBackendStreamingRenderRef: MutableRefObject<boolean>;
  autoExpandedThinkingKeysRef: MutableRefObject<Set<string>>;
  streamingTextSegmentsRef: MutableRefObject<string[]>;
  activeTextSegmentIndexRef: MutableRefObject<number>;
  streamingThinkingSegmentsRef: MutableRefObject<string[]>;
  activeThinkingSegmentIndexRef: MutableRefObject<number>;
  seenToolUseCountRef: MutableRefObject<number>;
  streamingMessageIndexRef: MutableRefObject<number>;
  lastContentUpdateRef: MutableRefObject<number>;
  contentUpdateTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  lastThinkingUpdateRef: MutableRefObject<number>;
  thinkingUpdateTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;

  // Functions from useStreamingMessages
  findLastAssistantIndex: (messages: ClaudeMessage[]) => number;
  extractRawBlocks: (raw: ClaudeRawMessage | string | undefined) => Array<Record<string, unknown>>;
  getOrCreateStreamingAssistantIndex: (messages: ClaudeMessage[]) => number;
  patchAssistantForStreaming: (msg: ClaudeMessage) => ClaudeMessage;

  // Other functions
  syncActiveProviderModelMapping: (provider: ProviderConfig) => void;

  // Permission dialog handlers from useDialogManagement
  openPermissionDialog: (request: PermissionRequest) => void;
  openAskUserQuestionDialog: (request: AskUserQuestionRequest) => void;
  openPlanApprovalDialog: (request: PlanApprovalRequest) => void;
}

export function useWindowCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    t,
    addToast,
    setMessages,
    setStatus,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setExpandedThinking,
    setStreamingActive,
    setHistoryData,
    setCurrentSessionId,
    setUsagePercentage,
    setUsageUsedTokens,
    setUsageMaxTokens,
    setPermissionMode,
    setClaudePermissionMode,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setProviderConfigVersion,
    setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled,
    setStreamingEnabledSetting,
    setSendShortcut,
    setAutoOpenFileEnabled,
    setSdkStatus,
    setSdkStatusLoaded,
    setIsRewinding,
    setRewindDialogOpen,
    setCurrentRewindRequest,
    setContextInfo,
    setSelectedAgent,
    currentProviderRef,
    messagesContainerRef,
    isUserAtBottomRef,
    suppressNextStatusToastRef,
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
    lastContentUpdateRef,
    contentUpdateTimeoutRef,
    lastThinkingUpdateRef,
    thinkingUpdateTimeoutRef,
    findLastAssistantIndex,
    extractRawBlocks,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,
    syncActiveProviderModelMapping,
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
  } = options;

  // Store t in ref to avoid stale closures
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    const getRawUuid = (msg: ClaudeMessage | undefined): string | undefined => {
      const raw = msg?.raw;
      if (!raw || typeof raw !== 'object') return undefined;
      return (raw as any).uuid as string | undefined;
    };

    const stripUuidFromRaw = (raw: unknown): unknown => {
      if (!raw || typeof raw !== 'object') return raw;
      const rawObj = raw as any;
      if (!('uuid' in rawObj)) return raw;
      const { uuid: _uuid, ...rest } = rawObj;
      return rest;
    };

    const preserveMessageIdentity = (prevMsg: ClaudeMessage | undefined, nextMsg: ClaudeMessage): ClaudeMessage => {
      if (!prevMsg?.timestamp) return nextMsg;
      if (prevMsg.type !== nextMsg.type) return nextMsg;

      const prevUuid = getRawUuid(prevMsg);
      const nextUuid = getRawUuid(nextMsg);

      const nextWithStableTimestamp =
        nextMsg.timestamp === prevMsg.timestamp ? nextMsg : { ...nextMsg, timestamp: prevMsg.timestamp };

      if (!prevUuid && nextUuid) {
        return { ...nextWithStableTimestamp, raw: stripUuidFromRaw(nextWithStableTimestamp.raw) as any };
      }

      return nextWithStableTimestamp;
    };

    const appendOptimisticMessageIfMissing = (prevList: ClaudeMessage[], nextList: ClaudeMessage[]): ClaudeMessage[] => {
      const lastPrev = prevList[prevList.length - 1];
      if (!lastPrev?.isOptimistic) return nextList;

      const optimisticMsg = lastPrev;

      const matchFn = (m: ClaudeMessage) =>
        m.type === 'user' &&
        (m.content === optimisticMsg.content || m.content === (optimisticMsg.raw as any)?.message?.content?.[0]?.text) &&
        m.timestamp && optimisticMsg.timestamp &&
        Math.abs(new Date(m.timestamp).getTime() - new Date(optimisticMsg.timestamp).getTime()) < OPTIMISTIC_MESSAGE_TIME_WINDOW;

      const matchedIndex = nextList.findIndex(matchFn);
      if (matchedIndex < 0) {
        return [...nextList, optimisticMsg];
      }

      // Backend message matched the optimistic message. Preserve attachment blocks from the optimistic
      // message into the backend message's raw data; otherwise non-image file attachments won't be visible.
      const optimisticRaw = optimisticMsg.raw as any;
      const optimisticContent: unknown[] | undefined = optimisticRaw?.message?.content;
      if (Array.isArray(optimisticContent)) {
        const attachmentBlocks = optimisticContent.filter(
          (b: any) => b && typeof b === 'object' && b.type === 'attachment'
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

    const preserveLastAssistantIdentity = (prevList: ClaudeMessage[], nextList: ClaudeMessage[]): ClaudeMessage[] => {
      const prevAssistantIdx = findLastAssistantIndex(prevList);
      const nextAssistantIdx = findLastAssistantIndex(nextList);
      if (prevAssistantIdx < 0 || nextAssistantIdx < 0) return nextList;

      const prevAssistant = prevList[prevAssistantIdx];
      const nextAssistant = nextList[nextAssistantIdx];
      const stabilized = preserveMessageIdentity(prevAssistant, nextAssistant);
      if (stabilized === nextAssistant) return nextList;

      const copy = [...nextList];
      copy[nextAssistantIdx] = stabilized;
      return copy;
    };

    // ========== Message Callbacks ==========
    window.updateMessages = (json) => {
      // During session transition, ignore message updates from stale session callbacks to prevent cleared messages from being restored
      if (window.__sessionTransitioning) return;

      try {
        const parsed = JSON.parse(json) as ClaudeMessage[];

        setMessages((prev) => {
          // If streaming is active, delegate to the streaming logic
          if (isStreamingRef.current) {
            if (useBackendStreamingRenderRef.current) {
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

              smartMerged = preserveLastAssistantIdentity(prev, smartMerged);
              const result = appendOptimisticMessageIfMissing(prev, smartMerged);

              // FIX: In Claude mode, update streamingMessageIndexRef so that
              // onContentDelta knows which assistant message to update.
              const lastAssistantIdx = findLastAssistantIndex(result);
              if (lastAssistantIdx >= 0) {
                streamingMessageIndexRef.current = lastAssistantIdx;

                // FIX: If there is buffered streaming content (onContentDelta may fire before updateMessages),
                // apply it to the assistant message immediately to prevent content loss.
                // Guard: only use streaming buffer if it's longer; otherwise adopt backend content.
                if (streamingContentRef.current && result[lastAssistantIdx]?.type === 'assistant') {
                  const backendContent = result[lastAssistantIdx].content || '';
                  if (streamingContentRef.current.length >= backendContent.length) {
                    result[lastAssistantIdx] = patchAssistantForStreaming({
                      ...result[lastAssistantIdx],
                      content: streamingContentRef.current,
                      isStreaming: true,
                    });
                  } else {
                    // Backend has more complete content (e.g. includes tool_use blocks); sync buffer
                    streamingContentRef.current = backendContent;
                  }
                }
              }

              return result;
            }

            const lastAssistantIdx = findLastAssistantIndex(parsed);
            if (lastAssistantIdx < 0) {
              return appendOptimisticMessageIfMissing(prev, parsed);
            }
            // ... (rest of streaming logic)
            // Simplified handling due to code structure — reuse existing streaming logic.
            // Only the non-streaming case is handled below to avoid code duplication.
          }

          // Non-streaming case (or streaming hasn't started yet)
          if (!isStreamingRef.current) {
            // Smart merge: reuse old message objects for performance (works with WeakMap cache in App.tsx).
            // If a message is not the last one and its timestamp/type/content are identical, keep the old reference.
            let smartMerged = parsed.map((newMsg, i) => {
              // Always update the last message (it may still be streaming or its status may be changing)
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

            smartMerged = preserveLastAssistantIdentity(prev, smartMerged);
            return appendOptimisticMessageIfMissing(prev, smartMerged);
          }

          // Streaming + !useBackendStreamingRender: only update on tool_use changes
          const lastAssistantIdx = findLastAssistantIndex(parsed);
          if (lastAssistantIdx < 0) {
            return parsed;
          }

          const lastAssistant = parsed[lastAssistantIdx];
          const lastAssistantBlocks = extractRawBlocks(lastAssistant.raw);
          const toolUseCount = lastAssistantBlocks.filter((b) => b?.type === 'tool_use').length;
          if (toolUseCount < seenToolUseCountRef.current) {
            seenToolUseCountRef.current = toolUseCount;
          }
          const hasNewToolUse = toolUseCount > seenToolUseCountRef.current;
          const hasToolUse = toolUseCount > 0;

          if (!hasNewToolUse && !hasToolUse) {
            return prev;
          }

          if (hasNewToolUse) {
            seenToolUseCountRef.current = toolUseCount;
            activeTextSegmentIndexRef.current = -1;
            activeThinkingSegmentIndexRef.current = -1;
          }

          let patched = [...parsed];
          patched = appendOptimisticMessageIfMissing(prev, patched);
          patched = preserveLastAssistantIdentity(prev, patched);

          const patchedAssistantIdx = findLastAssistantIndex(patched);
          if (patchedAssistantIdx >= 0 && patched[patchedAssistantIdx]?.type === 'assistant') {
            streamingMessageIndexRef.current = patchedAssistantIdx;
            patched[patchedAssistantIdx] = patchAssistantForStreaming(patched[patchedAssistantIdx]);
          }

          return patched;
        });
      } catch (error) {
        console.error('[Frontend] Failed to parse messages:', error);
      }
    };

    window.updateStatus = (text) => {
      // Backend sends updateStatus after creating a new session; clear the message update suppression flag
      if (window.__sessionTransitioning) {
        window.__sessionTransitioning = false;
      }
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
      // This check must happen before dispatching events to keep backend and frontend state consistent.
      if (!isLoading && isStreamingRef.current) {
        console.log('[Frontend] Ignoring showLoading(false) during streaming');
        return;
      }

      // Notify backend about loading state change for tab indicator
      sendBridgeEvent('tab_loading_changed', JSON.stringify({ loading: isLoading }));

      // FIX: Use closure to capture the current loading state, ensuring timestamps are set correctly during transitions
      setLoading((prevLoading) => {
        if (isLoading) {
          // false -> true transition: set a new timestamp (new loading cycle).
          // true -> true transition: keep the existing timestamp (avoid timer reset on repeated calls).
          if (!prevLoading) {
            setLoadingStartTime(Date.now());
          }
        } else {
          // Loading ended — reset the timestamp
          setLoadingStartTime(null);
        }
        return isLoading;
      });
    };

    window.showThinkingStatus = (value) => setIsThinking(isTruthy(value));
    window.setHistoryData = (data) => setHistoryData(data);
    window.clearMessages = () => {
      window.__deniedToolIds?.clear();
      setMessages([]);
    };
    window.addErrorMessage = (message) => addToast(message, 'error');

    window.addHistoryMessage = (message: ClaudeMessage) => {
      setMessages((prev) => [...prev, message]);
    };

    // History load complete callback — triggers Markdown re-rendering
    // to fix the issue where Markdown doesn't render on first history load.
    window.historyLoadComplete = () => {
      // Trigger a component re-render by updating the last message reference (avoids O(n) shallow copy)
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        // Update the last message's reference to trigger rendering
        const updated = [...prev];
        updated[updated.length - 1] = { ...updated[updated.length - 1] };
        return updated;
      });
    };

    window.addUserMessage = (content: string) => {
      const userMessage: ClaudeMessage = {
        type: 'user',
        content: content || '',
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);
      isUserAtBottomRef.current = true;
      requestAnimationFrame(() => {
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
        }
      });
    };

    // ========== Streaming Callbacks ==========
    window.onStreamStart = () => {
      console.log('[Frontend] Stream started');
      streamingContentRef.current = '';
      isStreamingRef.current = true;
      useBackendStreamingRenderRef.current = false;
      autoExpandedThinkingKeysRef.current.clear();
      setStreamingActive(true);
      isUserAtBottomRef.current = true;
      streamingTextSegmentsRef.current = [];
      activeTextSegmentIndexRef.current = -1;
      streamingThinkingSegmentsRef.current = [];
      activeThinkingSegmentIndexRef.current = -1;
      seenToolUseCountRef.current = 0;

      // FIX: Always reset streamingMessageIndexRef regardless of backend streaming mode,
      // otherwise the second question would reuse the first question's index, causing misplaced responses
      streamingMessageIndexRef.current = -1;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.type === 'assistant' && last?.isStreaming) {
          streamingMessageIndexRef.current = prev.length - 1;
          return prev;
        }
        streamingMessageIndexRef.current = prev.length;
        return [...prev, {
          type: 'assistant',
          content: '',
          isStreaming: true,
          timestamp: new Date().toISOString()
        }];
      });
    };

    window.onContentDelta = (delta: string) => {
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
          // FIX: In Claude mode, use streamingMessageIndexRef.current directly instead of
          // getOrCreateStreamingAssistantIndex, to avoid matching a stale assistant message.
          let idx: number;
          if (useBackendStreamingRenderRef.current) {
            idx = streamingMessageIndexRef.current;
            // Index is still -1, meaning the backend hasn't created the assistant via updateMessages yet.
            // Wait for the backend to create it; skip the update for now.
            if (idx < 0) {
              return prev;
            }
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
          // FIX: In Claude mode, use streamingMessageIndexRef.current directly instead of
          // getOrCreateStreamingAssistantIndex, to avoid matching a stale assistant message.
          let idx: number;
          if (useBackendStreamingRenderRef.current) {
            idx = streamingMessageIndexRef.current;
            // Index is still -1, meaning the backend hasn't created the assistant via updateMessages yet.
            // Wait for the backend to create it; skip the update for now.
            if (idx < 0) {
              return prev;
            }
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
      console.log('[Frontend] Stream ended');

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

      // Flush final content BEFORE marking stream as ended,
      // so late-arriving deltas are not discarded by the isStreamingRef guard.
      setMessages((prev) => {
        const newMessages = [...prev];
        const idx = streamingMessageIndexRef.current;
        if (idx >= 0 && idx < newMessages.length && newMessages[idx]?.type === 'assistant') {
          const finalContent = streamingContentRef.current;
          newMessages[idx] = {
            ...newMessages[idx],
            content: finalContent || newMessages[idx].content,
            isStreaming: false,
          };
        }
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

      // Collect tool IDs that need to be marked as denied
      const idsToAdd: string[] = [];

      setMessages((currentMessages) => {
        try {
          // Traverse from the end to find the last message containing incomplete tool calls
          for (let i = currentMessages.length - 1; i >= 0; i--) {
            const msg = currentMessages[i];
            if (msg.type === 'assistant' && msg.raw) {
              const rawObj = typeof msg.raw === 'string' ? JSON.parse(msg.raw) : msg.raw;
              const content = rawObj.content || rawObj.message?.content;

              if (Array.isArray(content)) {
                const toolUses = content.filter(
                  (block: { type?: string; id?: string }) => block.type === 'tool_use' && block.id
                ) as Array<{ type: string; id: string; name?: string }>;

                if (toolUses.length > 0) {
                  // Check whether these tool calls already have results
                  const nextMsg = currentMessages[i + 1];
                  const existingResultIds = new Set<string>();

                  if (nextMsg?.type === 'user' && nextMsg.raw) {
                    const nextRaw = typeof nextMsg.raw === 'string' ? JSON.parse(nextMsg.raw) : nextMsg.raw;
                    const nextContent = nextRaw.content || nextRaw.message?.content;
                    if (Array.isArray(nextContent)) {
                      nextContent.forEach((block: { type?: string; tool_use_id?: string }) => {
                        if (block.type === 'tool_result' && block.tool_use_id) {
                          existingResultIds.add(block.tool_use_id);
                        }
                      });
                    }
                  }

                  // Collect tool call IDs that have no corresponding result
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

        // Return a new array reference to trigger a re-render
        return [...currentMessages];
      });

      // Mutate global state outside the updater to avoid side-effect issues in concurrent mode
      for (const id of idsToAdd) {
        window.__deniedToolIds!.add(id);
      }
    };

    // ========== Session Callbacks ==========
    window.setSessionId = (sessionId: string) => {
      console.log('[Frontend] setSessionId:', sessionId);
      setCurrentSessionId(sessionId);
    };

    window.addToast = (message, type) => {
      addToast(message, type as 'info' | 'success' | 'warning' | 'error' | undefined);
    };

    window.onExportSessionData = (json) => {
      try {
        const data = JSON.parse(json);
        // Backend sends: { sessionId, title, messages }
        if (data.sessionId && data.messages) {
          // Format the export content
          const exportContent = JSON.stringify(data, null, 2);
          // Generate filename from title, sanitize for file system
          const sanitizedTitle = (data.title || 'session')
            .replace(/[<>:"/\\|?*]/g, '_')  // Replace invalid file name chars
            .replace(/\s+/g, '_')            // Replace spaces with underscores
            .substring(0, 50);               // Limit length
          const filename = `${sanitizedTitle}_${data.sessionId.substring(0, 8)}.json`;
          // Use downloadJSON which calls backend to show native file save dialog
          downloadJSON(exportContent, filename);
        } else if (data.error) {
          addToast(data.error, 'error');
        } else {
          addToast(tRef.current('history.exportFailed'), 'error');
        }
      } catch (error) {
        console.error('[Frontend] Failed to process export data:', error);
        addToast(tRef.current('history.exportFailed'), 'error');
      }
    };

    // ========== SDK Status Callbacks ==========
    const originalUpdateDependencyStatus = window.updateDependencyStatus;
    window.updateDependencyStatus = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        console.log('[Frontend] updateDependencyStatus:', data);
        setSdkStatus(data);
        setSdkStatusLoaded(true);
      } catch (error) {
        console.error('[Frontend] Failed to parse dependency status:', error);
      }
      if (originalUpdateDependencyStatus && originalUpdateDependencyStatus !== window.updateDependencyStatus) {
        originalUpdateDependencyStatus(jsonStr);
      }
    };
    (window as unknown as Record<string, unknown>)._appUpdateDependencyStatus = window.updateDependencyStatus;

    if ((window as unknown as Record<string, unknown>).__pendingDependencyStatus) {
      const pending = (window as unknown as Record<string, unknown>).__pendingDependencyStatus as string;
      delete (window as unknown as Record<string, unknown>).__pendingDependencyStatus;
      window.updateDependencyStatus?.(pending);
    }

    if (window.sendToJava) {
      window.sendToJava('get_dependency_status:');
    }

    // ========== Usage & Mode Callbacks ==========
    window.onUsageUpdate = (json) => {
      try {
        const data = JSON.parse(json);
        if (typeof data.percentage === 'number') {
          let used = typeof data.usedTokens === 'number' ? data.usedTokens : (typeof data.totalTokens === 'number' ? data.totalTokens : undefined);
          const max = typeof data.maxTokens === 'number' ? data.maxTokens : (typeof data.limit === 'number' ? data.limit : undefined);

          // Data validation: if usedTokens exceeds 2x maxTokens, the data may be incorrect.
          // Log a warning but still display the value (don't clamp, so users can see the anomaly).
          if (used !== undefined && max !== undefined && used > max * 2) {
            console.warn('[Frontend] Usage data may be incorrect: used=' + used + ', max=' + max);
          }

          // Clamp percentage to the 0-100 range
          const safePercentage = Math.max(0, Math.min(100, data.percentage));

          setUsagePercentage(safePercentage);
          setUsageUsedTokens(used);
          setUsageMaxTokens(max);
        }
      } catch (error) {
        console.error('[Frontend] Failed to parse usage update:', error);
      }
    };

    const updateMode = (mode?: PermissionMode, providerOverride?: string) => {
      const activeProvider = providerOverride || currentProviderRef.current;
      if (activeProvider === 'codex') {
        setPermissionMode('bypassPermissions');
        return;
      }
      if (mode === 'default' || mode === 'plan' || mode === 'acceptEdits' || mode === 'bypassPermissions') {
        setPermissionMode(mode);
        setClaudePermissionMode(mode);
      }
    };

    window.onModeChanged = (mode) => updateMode(mode as PermissionMode);
    window.onModeReceived = (mode) => updateMode(mode as PermissionMode);

    window.onModelChanged = (modelId) => {
      const provider = currentProviderRef.current;
      console.log('[Frontend] onModelChanged:', { modelId, provider });
      if (provider === 'claude') {
        setSelectedClaudeModel(modelId);
      } else if (provider === 'codex') {
        setSelectedCodexModel(modelId);
      }
    };

    window.onModelConfirmed = (modelId, provider) => {
      console.log('[Frontend] onModelConfirmed:', { modelId, provider });
      if (provider === 'claude') {
        setSelectedClaudeModel(modelId);
      } else if (provider === 'codex') {
        setSelectedCodexModel(modelId);
      }
    };

    window.updateActiveProvider = (jsonStr: string) => {
      try {
        const provider: ProviderConfig = JSON.parse(jsonStr);
        syncActiveProviderModelMapping(provider);
        setProviderConfigVersion(prev => prev + 1);
        setActiveProviderConfig(provider);
      } catch (error) {
        console.error('[Frontend] Failed to parse active provider in App:', error);
      }
    };

    window.updateThinkingEnabled = (jsonStr: string) => {
      const trimmed = (jsonStr || '').trim();
      try {
        const data = JSON.parse(trimmed);
        if (typeof data === 'boolean') {
          setClaudeSettingsAlwaysThinkingEnabled(data);
          return;
        }
        if (data && typeof data.enabled === 'boolean') {
          setClaudeSettingsAlwaysThinkingEnabled(data.enabled);
          return;
        }
      } catch {
        if (trimmed === 'true' || trimmed === 'false') {
          setClaudeSettingsAlwaysThinkingEnabled(trimmed === 'true');
        }
      }
    };

    window.updateStreamingEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setStreamingEnabledSetting(data.streamingEnabled ?? true);
      } catch (error) {
        console.error('[Frontend] Failed to parse streaming enabled:', error);
      }
    };

    // Handle pending streaming enabled data (from main.tsx pre-registration)
    if ((window as unknown as Record<string, unknown>).__pendingStreamingEnabled) {
      const pending = (window as unknown as Record<string, unknown>).__pendingStreamingEnabled as string;
      delete (window as unknown as Record<string, unknown>).__pendingStreamingEnabled;
      window.updateStreamingEnabled?.(pending);
    }

    window.updateSendShortcut = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        if (data.sendShortcut === 'enter' || data.sendShortcut === 'cmdEnter') {
          setSendShortcut(data.sendShortcut);
        }
      } catch (error) {
        console.error('[Frontend] Failed to parse send shortcut:', error);
      }
    };

    // Handle pending send shortcut data (from main.tsx pre-registration)
    if ((window as unknown as Record<string, unknown>).__pendingSendShortcut) {
      const pending = (window as unknown as Record<string, unknown>).__pendingSendShortcut as string;
      delete (window as unknown as Record<string, unknown>).__pendingSendShortcut;
      window.updateSendShortcut?.(pending);
    }

    window.updateAutoOpenFileEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setAutoOpenFileEnabled(data.autoOpenFileEnabled ?? true);
      } catch (error) {
        console.error('[Frontend] Failed to parse auto open file enabled:', error);
      }
    };

    // Handle pending auto open file enabled data (from main.tsx pre-registration)
    if ((window as unknown as Record<string, unknown>).__pendingAutoOpenFileEnabled) {
      const pending = (window as unknown as Record<string, unknown>).__pendingAutoOpenFileEnabled as string;
      delete (window as unknown as Record<string, unknown>).__pendingAutoOpenFileEnabled;
      window.updateAutoOpenFileEnabled?.(pending);
    }

    // Request initial settings with retry mechanism
    let settingsRetryCount = 0;
    const requestInitialSettings = () => {
      if (window.sendToJava) {
        window.sendToJava('get_streaming_enabled:');
        window.sendToJava('get_send_shortcut:');
        window.sendToJava('get_auto_open_file_enabled:');
      } else {
        settingsRetryCount++;
        if (settingsRetryCount < MAX_RETRIES) {
          setTimeout(requestInitialSettings, 100);
        }
      }
    };
    setTimeout(requestInitialSettings, 200);

    // ========== Permission Dialog Callbacks ==========
    window.showPermissionDialog = (json) => {
      try {
        const request = JSON.parse(json);
        openPermissionDialog(request);
      } catch (error) {
        console.error('[Frontend] Failed to parse permission request:', error);
      }
    };

    if (Array.isArray(window.__pendingPermissionDialogRequests) && window.__pendingPermissionDialogRequests.length > 0) {
      const pending = window.__pendingPermissionDialogRequests.slice();
      window.__pendingPermissionDialogRequests = [];
      for (const payload of pending) {
        window.showPermissionDialog?.(payload);
      }
    }

    window.showAskUserQuestionDialog = (json) => {
      try {
        const request = JSON.parse(json);
        openAskUserQuestionDialog(request);
      } catch (error) {
        console.error('[Frontend] Failed to parse ask user question request:', error);
      }
    };

    if (Array.isArray(window.__pendingAskUserQuestionDialogRequests) && window.__pendingAskUserQuestionDialogRequests.length > 0) {
      const pending = window.__pendingAskUserQuestionDialogRequests.slice();
      window.__pendingAskUserQuestionDialogRequests = [];
      for (const payload of pending) {
        window.showAskUserQuestionDialog?.(payload);
      }
    }

    window.showPlanApprovalDialog = (json) => {
      try {
        const request = JSON.parse(json);
        openPlanApprovalDialog(request);
      } catch (error) {
        console.error('[Frontend] Failed to parse plan approval request:', error);
      }
    };

    if (Array.isArray(window.__pendingPlanApprovalDialogRequests) && window.__pendingPlanApprovalDialogRequests.length > 0) {
      const pending = window.__pendingPlanApprovalDialogRequests.slice();
      window.__pendingPlanApprovalDialogRequests = [];
      for (const payload of pending) {
        window.showPlanApprovalDialog?.(payload);
      }
    }

    // ========== Rewind Result Callback ==========
    window.onRewindResult = (json: string) => {
      try {
        const result = JSON.parse(json);
        setIsRewinding(false);
        if (result.success) {
          setRewindDialogOpen(false);
          setCurrentRewindRequest(null);
          window.addToast?.(
            tRef.current('rewind.success'),
            'success'
          );
        } else {
          window.addToast?.(
            result.message || tRef.current('rewind.failed'),
            'error'
          );
        }
      } catch (error) {
        console.error('[Frontend] Failed to parse rewind result:', error);
        setIsRewinding(false);
        setRewindDialogOpen(false);
        setCurrentRewindRequest(null);
        window.addToast?.(tRef.current('rewind.parseError'), 'error');
      }
    };

    // ========== Selection Context Callbacks ==========
    window.addSelectionInfo = (selectionInfo) => {
      console.log('[Frontend] addSelectionInfo (auto) called:', selectionInfo);
      if (selectionInfo) {
        const match = selectionInfo.match(/^@([^#]+)(?:#L(\d+)(?:-(\d+))?)?$/);
        if (match) {
          const file = match[1];
          const startLine = match[2] ? parseInt(match[2], 10) : undefined;
          const endLine = match[3] ? parseInt(match[3], 10) : (startLine !== undefined ? startLine : undefined);
          setContextInfo({
            file,
            startLine,
            endLine,
            raw: selectionInfo
          });
          console.log('[Frontend] Updated ContextBar (auto):', { file, startLine, endLine });
        }
      }
    };

    window.addCodeSnippet = (selectionInfo) => {
      console.log('[Frontend] addCodeSnippet (manual) called:', selectionInfo);
      if (selectionInfo && window.insertCodeSnippetAtCursor) {
        window.insertCodeSnippetAtCursor(selectionInfo);
      }
    };

    window.clearSelectionInfo = () => {
      console.log('[Frontend] clearSelectionInfo called');
      setContextInfo(null);
    };

    // ========== Agent Callbacks ==========
    window.onSelectedAgentReceived = (json) => {
      console.log('[Frontend] onSelectedAgentReceived:', json);
      try {
        if (!json || json === 'null' || json === '{}') {
          setSelectedAgent(null);
          return;
        }
        const data = JSON.parse(json);
        const agentFromNewShape = data?.agent;
        const agentFromLegacyShape = data;

        const agentData = agentFromNewShape?.id ? agentFromNewShape : (agentFromLegacyShape?.id ? agentFromLegacyShape : null);
        if (!agentData) {
          setSelectedAgent(null);
          return;
        }

        setSelectedAgent({
          id: agentData.id,
          name: agentData.name || '',
          prompt: agentData.prompt,
        });
      } catch (error) {
        console.error('[Frontend] Failed to parse selected agent:', error);
        setSelectedAgent(null);
      }
    };

    window.onSelectedAgentChanged = (json) => {
      console.log('[Frontend] onSelectedAgentChanged:', json);
      try {
        if (!json || json === 'null' || json === '{}') {
          setSelectedAgent(null);
          return;
        }

        const data = JSON.parse(json);
        if (data?.success === false) {
          return;
        }

        const agentData = data?.agent;
        if (!agentData || !agentData.id) {
          setSelectedAgent(null);
          return;
        }

        setSelectedAgent({
          id: agentData.id,
          name: agentData.name || '',
          prompt: agentData.prompt,
        });
      } catch (error) {
        console.error('[Frontend] Failed to parse selected agent changed:', error);
      }
    };

    // ========== Slash Commands Setup ==========
    resetSlashCommandsState();
    resetFileReferenceState();
    setupSlashCommandsCallback();

    // ========== Request Initial States ==========
    let retryCount = 0;
    const MAX_RETRIES = 30;
    const requestActiveProvider = () => {
      if (window.sendToJava) {
        sendBridgeEvent('get_active_provider');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          setTimeout(requestActiveProvider, 100);
        }
      }
    };
    setTimeout(requestActiveProvider, 200);

    let thinkingRetryCount = 0;
    const requestThinkingEnabled = () => {
      if (window.sendToJava) {
        sendBridgeEvent('get_thinking_enabled');
      } else {
        thinkingRetryCount++;
        if (thinkingRetryCount < MAX_RETRIES) {
          setTimeout(requestThinkingEnabled, 100);
        }
      }
    };
    setTimeout(requestThinkingEnabled, 200);
  }, []);
}
