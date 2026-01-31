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
      const isIncluded = nextList.some((m) =>
        m.type === 'user' &&
        (m.content === optimisticMsg.content || m.content === (optimisticMsg.raw as any)?.message?.content?.[0]?.text) &&
        m.timestamp && optimisticMsg.timestamp &&
        Math.abs(new Date(m.timestamp).getTime() - new Date(optimisticMsg.timestamp).getTime()) < OPTIMISTIC_MESSAGE_TIME_WINDOW
      );

      if (isIncluded) return nextList;
      return [...nextList, optimisticMsg];
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
      // 会话过渡期间，忽略旧会话回调发来的消息更新，防止已清空的消息被写回
      if (window.__sessionTransitioning) return;

      try {
        const parsed = JSON.parse(json) as ClaudeMessage[];

        setMessages((prev) => {
          // 如果正在流式传输，交给流式逻辑处理
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

              // FIX: 在 Claude 模式下，需要更新 streamingMessageIndexRef
              // 这样 onContentDelta 才能知道应该更新哪个 assistant
              const lastAssistantIdx = findLastAssistantIndex(result);
              if (lastAssistantIdx >= 0) {
                streamingMessageIndexRef.current = lastAssistantIdx;

                // FIX: 如果有缓存的流式内容（onContentDelta 可能先于 updateMessages 被调用）
                // 需要立即应用到 assistant 消息上，确保内容不丢失
                if (streamingContentRef.current && result[lastAssistantIdx]?.type === 'assistant') {
                  result[lastAssistantIdx] = patchAssistantForStreaming({
                    ...result[lastAssistantIdx],
                    content: streamingContentRef.current,
                    isStreaming: true,
                  });
                }
              }

              return result;
            }

            const lastAssistantIdx = findLastAssistantIndex(parsed);
            if (lastAssistantIdx < 0) {
              return appendOptimisticMessageIfMissing(prev, parsed);
            }
            // ... (rest of streaming logic)
            // 由于代码结构原因，这里简化处理，流式传输时直接复用原有逻辑
            // 为了避免重复代码，这里我们只处理非流式的情况
          }

          // 非流式传输情况（或流式还没开始）
          if (!isStreamingRef.current) {
            // 智能合并：复用旧消息对象以优化性能（配合 App.tsx 中的 WeakMap 缓存）
            // 如果不是最后一条消息，且 timestamp/type/content 相同，则认为消息未变，复用引用
            let smartMerged = parsed.map((newMsg, i) => {
              // 总是更新最后一条消息（可能在流式生成中，或者状态在变）
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

          // 下面是原有的流式处理逻辑，我们需要保留它
          // 因为不能在 if (!isStreamingRef.current) 里 return，所以这里需要重复一下或者重构
          // 为了最小化改动，我将把流式逻辑复制在这里（或者保持原样）
          
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

            // FIX: 在 Claude 模式下，需要更新 streamingMessageIndexRef
            const lastAssistantIdx = findLastAssistantIndex(result);
            if (lastAssistantIdx >= 0) {
              streamingMessageIndexRef.current = lastAssistantIdx;

              // FIX: 如果有缓存的流式内容，需要立即应用
              if (streamingContentRef.current && result[lastAssistantIdx]?.type === 'assistant') {
                result[lastAssistantIdx] = patchAssistantForStreaming({
                  ...result[lastAssistantIdx],
                  content: streamingContentRef.current,
                  isStreaming: true,
                });
              }
            }

            return result;
          }

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
      // 后端创建新会话完成后会发送 updateStatus，解除消息更新抑制
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

      // FIX: 流式传输期间忽略 loading=false，由 onStreamEnd 统一处理
      // 必须在发送事件之前检查，避免后端状态与前端不一致
      if (!isLoading && isStreamingRef.current) {
        console.log('[Frontend] Ignoring showLoading(false) during streaming');
        return;
      }

      // Notify backend about loading state change for tab indicator
      sendBridgeEvent('tab_loading_changed', JSON.stringify({ loading: isLoading }));

      // FIX: 使用闭包捕获当前loading状态，确保状态转换时正确设置时间戳
      setLoading((prevLoading) => {
        if (isLoading) {
          // 如果是从 false -> true 的转换，设置新的时间戳（新的loading周期）
          // 如果是 true -> true 的转换，保持旧的时间戳（避免重复调用导致计时器重置）
          if (!prevLoading) {
            setLoadingStartTime(Date.now());
          }
        } else {
          // loading结束，重置时间戳
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

      // FIX: 无论是否使用后端流式渲染，都必须重置 streamingMessageIndexRef
      // 否则第二次提问时会使用第一次的索引，导致回复位置错乱
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
          // FIX: 在 Claude 模式下，不使用 getOrCreateStreamingAssistantIndex 查找
          // 而是直接使用 streamingMessageIndexRef.current，避免找到错误的旧 assistant
          let idx: number;
          if (useBackendStreamingRenderRef.current) {
            idx = streamingMessageIndexRef.current;
            // 如果索引还是 -1，说明后端还没有通过 updateMessages 创建 assistant
            // 这时候需要等待后端创建，暂时不更新
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
          // FIX: 在 Claude 模式下，不使用 getOrCreateStreamingAssistantIndex 查找
          // 而是直接使用 streamingMessageIndexRef.current，避免找到错误的旧 assistant
          let idx: number;
          if (useBackendStreamingRenderRef.current) {
            idx = streamingMessageIndexRef.current;
            // 如果索引还是 -1，说明后端还没有通过 updateMessages 创建 assistant
            // 这时候需要等待后端创建，暂时不更新
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
      isStreamingRef.current = false;
      useBackendStreamingRenderRef.current = false;

      // Notify backend about stream completion for tab status indicator
      sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'completed' }));

      if (contentUpdateTimeoutRef.current) {
        clearTimeout(contentUpdateTimeoutRef.current);
        contentUpdateTimeoutRef.current = null;
      }
      if (thinkingUpdateTimeoutRef.current) {
        clearTimeout(thinkingUpdateTimeoutRef.current);
        thinkingUpdateTimeoutRef.current = null;
      }

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

    // 权限被拒绝回调 - 标记未完成的工具调用为"中断"状态
    window.onPermissionDenied = () => {
      if (!window.__deniedToolIds) {
        window.__deniedToolIds = new Set<string>();
      }

      // 收集需要标记为拒绝的工具 ID
      const idsToAdd: string[] = [];

      setMessages((currentMessages) => {
        try {
          // 从后向前遍历，找到最后一条包含未完成工具调用的消息
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
                  // 检查这些工具调用是否已经有结果
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

                  // 收集没有结果的工具调用 ID
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

        // 返回新数组引用以触发重新渲染
        return [...currentMessages];
      });

      // 在 updater 外部修改全局状态，避免并发模式下的副作用问题
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
          const used = typeof data.usedTokens === 'number' ? data.usedTokens : (typeof data.totalTokens === 'number' ? data.totalTokens : undefined);
          const max = typeof data.maxTokens === 'number' ? data.maxTokens : (typeof data.limit === 'number' ? data.limit : undefined);
          setUsagePercentage(data.percentage);
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

    // Request initial settings with retry mechanism
    let settingsRetryCount = 0;
    const requestInitialSettings = () => {
      if (window.sendToJava) {
        window.sendToJava('get_streaming_enabled:');
        window.sendToJava('get_send_shortcut:');
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
