import { useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { MutableRefObject, RefObject } from 'react';
import type { ClaudeMessage, ClaudeRawMessage, HistoryData } from '../types';
import type { PermissionMode, SelectedAgent } from '../components/ChatInputBox/types';
import type { ProviderConfig } from '../types/provider';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';
import type { RewindRequest } from '../components/RewindDialog';
import { THROTTLE_INTERVAL } from './useStreamingMessages';
import { sendBridgeEvent } from '../utils/bridge';
import { setupSlashCommandsCallback, resetSlashCommandsState, resetFileReferenceState } from '../components/ChatInputBox/providers';

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
  } = options;

  // Store t in ref to avoid stale closures
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    // ========== Message Callbacks ==========
    window.updateMessages = (json) => {
      try {
        const parsed = JSON.parse(json) as ClaudeMessage[];

        setMessages((prev) => {
          // 如果正在流式传输，交给流式逻辑处理
          if (isStreamingRef.current) {
            if (useBackendStreamingRenderRef.current) {
              return parsed;
            }

            const lastAssistantIdx = findLastAssistantIndex(parsed);
            if (lastAssistantIdx < 0) {
              return parsed;
            }
            // ... (rest of streaming logic)
            // 由于代码结构原因，这里简化处理，流式传输时直接复用原有逻辑
            // 为了避免重复代码，这里我们只处理非流式的情况
          }

          // 非流式传输情况（或流式还没开始）
          if (!isStreamingRef.current) {
            // 智能合并：复用旧消息对象以优化性能（配合 App.tsx 中的 WeakMap 缓存）
            // 如果不是最后一条消息，且 timestamp/type/content 相同，则认为消息未变，复用引用
            const smartMerged = parsed.map((newMsg, i) => {
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

            // 检查 prev 中是否有乐观消息
            const lastMsg = prev[prev.length - 1];
            const hasOptimisticMsg = lastMsg && lastMsg.isOptimistic;

            if (hasOptimisticMsg) {
              // 检查 smartMerged 是否包含我们的 optimistic message
              const optimisticMsg = lastMsg;
              const isIncluded = smartMerged.some((m) =>
                m.type === 'user' &&
                (m.content === optimisticMsg.content || m.content === (optimisticMsg.raw as any)?.message?.content?.[0]?.text) &&
                m.timestamp && optimisticMsg.timestamp &&
                Math.abs(new Date(m.timestamp).getTime() - new Date(optimisticMsg.timestamp).getTime()) < OPTIMISTIC_MESSAGE_TIME_WINDOW
              );

              if (!isIncluded) {
                // 如果后端返回的列表不包含我们的乐观消息，把它拼回去
                return [...smartMerged, optimisticMsg];
              }
            }
            return smartMerged;
          }

          // 下面是原有的流式处理逻辑，我们需要保留它
          // 因为不能在 if (!isStreamingRef.current) 里 return，所以这里需要重复一下或者重构
          // 为了最小化改动，我将把流式逻辑复制在这里（或者保持原样）
          
          if (useBackendStreamingRenderRef.current) {
            return parsed;
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

          const patched = [...parsed];
          const targetIdx = streamingMessageIndexRef.current >= 0 ? streamingMessageIndexRef.current : lastAssistantIdx;
          if (targetIdx >= 0 && patched[targetIdx]?.type === 'assistant') {
            patched[targetIdx] = patchAssistantForStreaming(patched[targetIdx]);
          }
          return patched;
        });
      } catch (error) {
        console.error('[Frontend] Failed to parse messages:', error);
      }
    };

    window.updateStatus = (text) => {
      setStatus(text);
      if (suppressNextStatusToastRef.current) {
        suppressNextStatusToastRef.current = false;
        return;
      }
      addToast(text);
    };

    window.showLoading = (value) => {
      const isLoading = isTruthy(value);
      setLoading(isLoading);
      if (isLoading) {
        setLoadingStartTime(Date.now());
      } else {
        setLoadingStartTime(null);
      }
    };

    window.showThinkingStatus = (value) => setIsThinking(isTruthy(value));
    window.setHistoryData = (data) => setHistoryData(data);
    window.clearMessages = () => setMessages([]);
    window.addErrorMessage = (message) =>
      setMessages((prev) => [...prev, { type: 'error', content: message }]);

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
      useBackendStreamingRenderRef.current = currentProviderRef.current === 'claude';
      autoExpandedThinkingKeysRef.current.clear();
      setStreamingActive(true);
      isUserAtBottomRef.current = true;
      streamingTextSegmentsRef.current = [];
      activeTextSegmentIndexRef.current = -1;
      streamingThinkingSegmentsRef.current = [];
      activeThinkingSegmentIndexRef.current = -1;
      seenToolUseCountRef.current = 0;

      if (useBackendStreamingRenderRef.current) {
        return;
      }
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

      if (timeSinceLastUpdate >= THROTTLE_INTERVAL) {
        lastContentUpdateRef.current = now;
        const currentContent = streamingContentRef.current;
        setMessages((prev) => {
          const newMessages = [...prev];
          const idx = getOrCreateStreamingAssistantIndex(newMessages);
          if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
            newMessages[idx] = patchAssistantForStreaming({
              ...newMessages[idx],
              content: currentContent,
              isStreaming: true,
            });
          }
          return newMessages;
        });
      } else {
        if (!contentUpdateTimeoutRef.current) {
          const remainingTime = THROTTLE_INTERVAL - timeSinceLastUpdate;
          contentUpdateTimeoutRef.current = setTimeout(() => {
            contentUpdateTimeoutRef.current = null;
            lastContentUpdateRef.current = Date.now();
            const currentContent = streamingContentRef.current;
            setMessages((prev) => {
              const newMessages = [...prev];
              const idx = getOrCreateStreamingAssistantIndex(newMessages);
              if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
                newMessages[idx] = patchAssistantForStreaming({
                  ...newMessages[idx],
                  content: currentContent,
                  isStreaming: true,
                });
              }
              return newMessages;
            });
          }, remainingTime);
        }
      }
    };

    window.onThinkingDelta = (delta: string) => {
      if (!isStreamingRef.current) return;
      activeTextSegmentIndexRef.current = -1;

      if (activeThinkingSegmentIndexRef.current < 0) {
        activeThinkingSegmentIndexRef.current = streamingThinkingSegmentsRef.current.length;
        streamingThinkingSegmentsRef.current.push('');
      }
      streamingThinkingSegmentsRef.current[activeThinkingSegmentIndexRef.current] += delta;

      const now = Date.now();
      const timeSinceLastUpdate = now - lastThinkingUpdateRef.current;

      if (timeSinceLastUpdate >= THROTTLE_INTERVAL) {
        lastThinkingUpdateRef.current = now;
        setMessages((prev) => {
          const newMessages = [...prev];
          const idx = getOrCreateStreamingAssistantIndex(newMessages);
          if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
            newMessages[idx] = patchAssistantForStreaming({
              ...newMessages[idx],
              isStreaming: true,
            });
          }
          return newMessages;
        });
      } else {
        if (!thinkingUpdateTimeoutRef.current) {
          const remainingTime = THROTTLE_INTERVAL - timeSinceLastUpdate;
          thinkingUpdateTimeoutRef.current = setTimeout(() => {
            thinkingUpdateTimeoutRef.current = null;
            lastThinkingUpdateRef.current = Date.now();
            setMessages((prev) => {
              const newMessages = [...prev];
              const idx = getOrCreateStreamingAssistantIndex(newMessages);
              if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
                newMessages[idx] = patchAssistantForStreaming({
                  ...newMessages[idx],
                  isStreaming: true,
                });
              }
              return newMessages;
            });
          }, remainingTime);
        }
      }
    };

    window.onStreamEnd = () => {
      console.log('[Frontend] Stream ended');
      isStreamingRef.current = false;
      useBackendStreamingRenderRef.current = false;

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
      setStreamingActive(false);
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
        if (data.success && data.content) {
          const blob = new Blob([data.content], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = data.filename || 'session.json';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          addToast(tRef.current('history.exportSuccess'), 'success');
        } else {
          addToast(data.error || tRef.current('history.exportFailed'), 'error');
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
        setStreamingEnabledSetting(data.streamingEnabled ?? false);
      } catch (error) {
        console.error('[Frontend] Failed to parse streaming enabled:', error);
      }
    };

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

    // Request initial settings
    if (window.sendToJava) {
      window.sendToJava('get_streaming_enabled:');
      window.sendToJava('get_send_shortcut:');
    }

    // ========== Permission Dialog Callbacks ==========
    window.showPermissionDialog = (json) => {
      try {
        const request = JSON.parse(json);
        openPermissionDialog(request);
      } catch (error) {
        console.error('[Frontend] Failed to parse permission request:', error);
      }
    };

    window.showAskUserQuestionDialog = (json) => {
      try {
        const request = JSON.parse(json);
        openAskUserQuestionDialog(request);
      } catch (error) {
        console.error('[Frontend] Failed to parse ask user question request:', error);
      }
    };

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
