import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useScrollBehavior,
  useSessionManagement,
  useStreamingMessages,
  useWindowCallbacks,
  useRewindHandlers,
  useHistoryLoader,
  useMessageQueue,
  useMessageProcessing,
  useMessageSender,
  useChatComputations,
} from './hooks';
import type { UseWindowCallbacksOptions, UseMessageSenderOptions } from './hooks';
import {
  NEW_SESSION_COMMANDS,
  RESUME_COMMANDS,
  PLAN_COMMANDS,
  CONTEXT_COMMANDS,
} from './hooks/useMessageSender';
import type { Attachment, ChatInputBoxHandle, PermissionMode } from './components/ChatInputBox/types';
import type { ChatScreenProps } from './components/ChatScreen';
import { useSubagentContextValues, useSetTaskEvents } from './contexts/SubagentContext';
import { useMessages } from './contexts/MessagesContext';
import { useSession } from './contexts/SessionContext';
import { useUIState } from './contexts/UIStateContext';
import { useDialogs } from './contexts/DialogContext';
import type { ApplyHistoryModel } from './applyHistoryModel';

/**
 * Subset of useModelProviderState's return consumed by this controller.
 * Field types are indexed from the option/props interfaces the values are
 * passed to (identical to what App.tsx wires today).
 */
export interface ChatControllerModelSlice {
  currentProvider: ChatScreenProps['currentProvider'];
  selectedModel: UseMessageSenderOptions['selectedModel'];
  permissionMode: UseMessageSenderOptions['permissionMode'];
  selectedAgent: UseMessageSenderOptions['selectedAgent'];
  sdkStatusLoading: UseMessageSenderOptions['sdkStatusLoading'];
  currentSdkInstalled: UseMessageSenderOptions['currentSdkInstalled'];
  codexNativeAutoReviewAvailable: UseMessageSenderOptions['codexNativeAutoReviewAvailable'];
  reasoningEffort: UseMessageSenderOptions['reasoningEffort'];
  codexFastMode: UseMessageSenderOptions['codexFastMode'];
  dshPreset: UseMessageSenderOptions['dshPreset'];
  longContextEnabled: UseMessageSenderOptions['longContextEnabled'];
  handleModeSelect: (mode: PermissionMode) => void;
  handleProviderSelect: (providerId: string) => void;
  currentProviderRef: UseWindowCallbacksOptions['currentProviderRef'];
  syncActiveProviderModelMapping: UseWindowCallbacksOptions['syncActiveProviderModelMapping'];
  setPermissionMode: UseWindowCallbacksOptions['setPermissionMode'];
  setCurrentProvider: UseWindowCallbacksOptions['setCurrentProvider'];
  setClaudePermissionMode: UseWindowCallbacksOptions['setClaudePermissionMode'];
  setCodexPermissionMode: UseWindowCallbacksOptions['setCodexPermissionMode'];
  setSelectedClaudeModel: UseWindowCallbacksOptions['setSelectedClaudeModel'];
  setSelectedCodexModel: UseWindowCallbacksOptions['setSelectedCodexModel'];
  setLongContextEnabled: UseWindowCallbacksOptions['setLongContextEnabled'];
  setReasoningEffort: UseWindowCallbacksOptions['setReasoningEffort'];
  setCodexFastMode: UseWindowCallbacksOptions['setCodexFastMode'];
  setProviderConfigVersion: UseWindowCallbacksOptions['setProviderConfigVersion'];
  setActiveProviderConfig: UseWindowCallbacksOptions['setActiveProviderConfig'];
  setClaudeSettingsAlwaysThinkingEnabled: UseWindowCallbacksOptions['setClaudeSettingsAlwaysThinkingEnabled'];
  setStreamingEnabledSetting: UseWindowCallbacksOptions['setStreamingEnabledSetting'];
  setSendShortcut: UseWindowCallbacksOptions['setSendShortcut'];
  setAutoOpenFileEnabled: UseWindowCallbacksOptions['setAutoOpenFileEnabled'];
  setSdkStatus: UseWindowCallbacksOptions['setSdkStatus'];
  setSdkStatusLoaded: UseWindowCallbacksOptions['setSdkStatusLoaded'];
  setSdkStatusError: UseWindowCallbacksOptions['setSdkStatusError'];
  setSelectedAgent: UseWindowCallbacksOptions['setSelectedAgent'];
  setUsagePercentage: UseWindowCallbacksOptions['setUsagePercentage'];
  setUsageUsedTokens: UseWindowCallbacksOptions['setUsageUsedTokens'];
  setUsageMaxTokens: UseWindowCallbacksOptions['setUsageMaxTokens'];
}

interface UseAppChatControllerOptions {
  model: ChatControllerModelSlice;
  applyHistoryModel: ApplyHistoryModel;
  setPermissionDialogTimeoutSeconds: Dispatch<SetStateAction<number>>;
}

/**
 * Chat orchestration extracted verbatim from App.tsx: scroll/streaming state,
 * session management, bridge window callbacks, message processing/sending,
 * the message queue, chat-view computations, and rewind handlers. Context
 * values are consumed directly here (same convention as ChatScreen /
 * AppDialogs) so App only receives the values its layout regions need.
 */
export const useAppChatController = ({
  model,
  applyHistoryModel,
  setPermissionDialogTimeoutSeconds,
}: UseAppChatControllerOptions) => {
  const { t } = useTranslation();

  // ── Dialog management (DialogContext) ──
  const {
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
    forceClosePermissionDialog,
    forceCloseAskUserQuestionDialog,
    forceClosePlanApprovalDialog,
    openContextUsageDialog,
    updateContextUsageData,
    closeContextUsageDialog,
    setRewindDialogOpen, setCurrentRewindRequest,
    isRewinding, setIsRewinding, setRewindSelectDialogOpen,
  } = useDialogs();

  // ── Messages flow state (MessagesContext) ──
  const {
    messages, setMessages,
    subagentHistories, setSubagentHistories,
    setStatus,
    loading, setLoading, setLoadingStartTime,
    setIsThinking,
    streamingActive, setStreamingActive,
  } = useMessages();

  // task_events live in TaskEventProvider (SubagentContext) so their updates do
  // not re-render every MessagesContext consumer.
  const setTaskEvents = useSetTaskEvents();

  // ── Session state (SessionContext) ──
  const {
    currentSessionId, setCurrentSessionId,
    customSessionTitle, setCustomSessionTitle,
    historyData, setHistoryData,
    currentSessionIdRef, customSessionTitleRef,
  } = useSession();

  // ── UI state (UIStateContext) ──
  const {
    currentView, setCurrentView,
    setSettingsInitialTab,
    addToast, clearToasts,
    setContextInfo,
  } = useUIState();

  const chatInputRef = useRef<ChatInputBoxHandle>(null);

  const {
    currentProvider, selectedModel, permissionMode,
    selectedAgent, sdkStatusLoading, currentSdkInstalled,
    codexNativeAutoReviewAvailable,
    reasoningEffort, codexFastMode, dshPreset, longContextEnabled,
    handleModeSelect, handleProviderSelect,
    currentProviderRef, syncActiveProviderModelMapping,
    setPermissionMode, setCurrentProvider,
    setClaudePermissionMode, setCodexPermissionMode,
    setSelectedClaudeModel, setSelectedCodexModel,
    setLongContextEnabled, setReasoningEffort, setCodexFastMode,
    setProviderConfigVersion, setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled, setStreamingEnabledSetting,
    setSendShortcut, setAutoOpenFileEnabled,
    setSdkStatus, setSdkStatusLoaded, setSdkStatusError, setSelectedAgent,
    setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
  } = model;

  // ── Scroll behavior ──
  const {
    messagesContainerRef, messagesEndRef, inputAreaRef,
    isUserAtBottomRef, isAutoScrollingRef, userPausedRef,
  } = useScrollBehavior({ currentView, messages, loading, streamingActive });

  // ── Streaming messages ──
  const {
    streamingContentRef, streamingThinkingRef, isStreamingRef, useBackendStreamingRenderRef,
    streamingMessageIndexRef, contentUpdateTimeoutRef, thinkingUpdateTimeoutRef,
    lastContentUpdateRef, lastThinkingUpdateRef, autoExpandedThinkingKeysRef,
    streamingTurnIdRef, turnIdCounterRef,
    findLastAssistantIndex, extractRawBlocks,
    getOrCreateStreamingAssistantIndex, patchAssistantForStreaming,
  } = useStreamingMessages();

  // Ref indirection breaks a hook-ordering cycle: useSessionManagement wants the
  // message queue's clearQueue, but that hook sits further down the chain
  // (useMessageQueue needs executeMessage, which needs forceCreateNewSession
  // from useSessionManagement). The stable wrapper keeps beginSessionTransition's
  // useCallback from re-creating on every render.
  const clearMessageQueueRef = useRef<() => void>(() => {});
  const clearQueuedMessages = useCallback(() => {
    clearMessageQueueRef.current();
  }, []);

  // ── Session management ──
  const {
    showNewSessionConfirm, showInterruptConfirm,
    suppressNextStatusToastRef,
    createNewSession, forceCreateNewSession,
    forceCreateNewSessionWithProvider,
    handleConfirmNewSession, handleCancelNewSession,
    handleConfirmInterrupt, handleCancelInterrupt,
    loadHistorySession, deleteHistorySession, deleteHistorySessions, exportHistorySession,
    toggleFavoriteSession, updateHistoryTitle, applyHistoryTitleLocal, convertToCliSession,
  } = useSessionManagement({
    messages, loading, historyData, currentSessionId, currentSessionIdRef, currentProvider,
    setHistoryData, setMessages, setCurrentView, setCurrentSessionId,
    setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setStatus, setLoading, setIsThinking, setStreamingActive,
    setTaskEvents,
    setSubagentHistories,
    clearToasts, addToast, t,
    applyHistoryModel,
    clearQueuedMessages,
  });

  useHistoryLoader({ currentView, currentProvider });

  // ── Window callbacks (bridge communication) ──
  useWindowCallbacks({
    t, addToast, clearToasts,
    setMessages, setStatus, setLoading, setLoadingStartTime,
    setIsThinking, setStreamingActive, setHistoryData,
    setCurrentSessionId, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setPermissionMode, setCurrentProvider, setClaudePermissionMode, setCodexPermissionMode,
    setSelectedClaudeModel, setSelectedCodexModel,
    setLongContextEnabled, setReasoningEffort, setCodexFastMode,
    setProviderConfigVersion, setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled, setStreamingEnabledSetting,
    setSendShortcut, setAutoOpenFileEnabled,
    setSdkStatus, setSdkStatusLoaded, setSdkStatusError,
    setIsRewinding, setRewindDialogOpen, setCurrentRewindRequest,
    setContextInfo, setSelectedAgent,
    setSubagentHistories,
    setTaskEvents,
    currentProviderRef, messagesContainerRef, isUserAtBottomRef, userPausedRef,
    suppressNextStatusToastRef,
    streamingContentRef, streamingThinkingRef, isStreamingRef, useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingMessageIndexRef,
    streamingTurnIdRef, turnIdCounterRef,
    lastContentUpdateRef, contentUpdateTimeoutRef,
    lastThinkingUpdateRef, thinkingUpdateTimeoutRef,
    findLastAssistantIndex, extractRawBlocks,
    getOrCreateStreamingAssistantIndex, patchAssistantForStreaming,
    syncActiveProviderModelMapping,
    openPermissionDialog, openAskUserQuestionDialog, openPlanApprovalDialog,
    forceClosePermissionDialog, forceCloseAskUserQuestionDialog, forceClosePlanApprovalDialog,
    openContextUsageDialog, updateContextUsageData,
    closeContextUsageDialog,
    customSessionTitleRef, currentSessionIdRef, updateHistoryTitle, applyHistoryTitleLocal,
    setCustomSessionTitle,
    setPermissionDialogTimeoutSeconds,
    clearQueuedMessages,
  });

  // ── Message processing ──
  const {
    getMessageText, getContentBlocks,
    mergedMessages, sentAttachmentsRef,
  } = useMessageProcessing({ messages, currentSessionId, t });

  // ── Message sender ──
  // Wrap handleProviderSelect to also clear messages and input (like creating a new session)
  const wrappedHandleProviderSelect = useCallback((providerId: string) => {
    chatInputRef.current?.clear();
    handleProviderSelect(providerId);
    forceCreateNewSessionWithProvider(providerId);
  }, [forceCreateNewSessionWithProvider, handleProviderSelect]);

  const {
    handleSubmit: hookHandleSubmit,
    executeMessage,
    interruptSession,
  } = useMessageSender({
    t, addToast,
    currentProvider, selectedModel, permissionMode, reasoningEffort, selectedAgent, codexFastMode,
    codexNativeAutoReviewAvailable, dshPreset,
    sdkStatusLoading, currentSdkInstalled,
    sentAttachmentsRef, chatInputRef, messagesContainerRef,
    isUserAtBottomRef, userPausedRef, isStreamingRef,
    setMessages, setLoading, setLoadingStartTime, setStreamingActive,
    setSettingsInitialTab, setCurrentView,
    forceCreateNewSession,
    handleModeSelect,
    longContextEnabled,
    openContextUsageDialog,
    closeContextUsageDialog,
  });

  // ── Message queue ──
  const {
    queue: messageQueue,
    enqueue: enqueueMessage,
    dequeue: dequeueMessage,
    clearQueue,
  } = useMessageQueue({ isLoading: loading, onExecute: executeMessage });

  // Point the session-transition indirection at the real clearQueue.
  useEffect(() => {
    clearMessageQueueRef.current = clearQueue;
  }, [clearQueue]);

  // handleSubmit with queue support (new session and local commands bypass loading check)
  const handleSubmit = useCallback((content: string, attachments?: Attachment[]) => {
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!text && !hasAttachments) return;
    // Local commands work even while loading
    if (text.startsWith('/')) {
      const command = text.split(/\s+/)[0].toLowerCase();
      // New session commands
      if (NEW_SESSION_COMMANDS.has(command)) {
        forceCreateNewSession();
        return;
      }
      // /resume - open history view
      if (RESUME_COMMANDS.has(command)) {
        setCurrentView('history');
        return;
      }
      // /plan - switch to plan mode (Claude only; Codex sends as normal text)
      if (PLAN_COMMANDS.has(command) && currentProvider === 'claude') {
        handleModeSelect('plan');
        addToast(t('chat.planModeEnabled', { defaultValue: 'Plan mode enabled' }), 'info');
        return;
      }
      // /context - handled locally even while loading
      if (CONTEXT_COMMANDS.has(command)) {
        hookHandleSubmit(content, attachments);
        return;
      }
    }
    // If loading, add to queue
    if (loading) {
      enqueueMessage(content, attachments);
      return;
    }
    hookHandleSubmit(content, attachments);
  }, [loading, enqueueMessage, hookHandleSubmit, forceCreateNewSession, currentProvider, handleModeSelect, setCurrentView, addToast, t]);

  // ── Chat-view computations (stage 5 of TASK-P1-01) ──
  const {
    findToolResult, getToolResultRaw,
    fileChangeMgmt,
    filteredFileChanges, subagents, globalTodos, rewindableMessages, sessionTitle,
  } = useChatComputations({
    t, messages, mergedMessages, subagentHistories, customSessionTitle, streamingActive, currentProvider,
    currentSessionId, currentSessionIdRef,
    getMessageText, getContentBlocks,
  });

  const { handleUndoFile, handleDiscardAll: handleDiscardAllRaw, handleKeepAll } = fileChangeMgmt;
  const onDiscardAll = useCallback(
    () => { handleDiscardAllRaw(filteredFileChanges); },
    [handleDiscardAllRaw, filteredFileChanges],
  );

  // Stabilize context value references for SubagentContext consumers.
  const { subagentHistoryCtxValue, sessionIdCtxValue } = useSubagentContextValues(
    subagentHistories,
    currentSessionId,
    currentProvider,
  );

  const handleNavigateToProviderSettings = useCallback(() => {
    setSettingsInitialTab('providers');
    setCurrentView('settings');
  }, [setSettingsInitialTab, setCurrentView]);

  // ── Rewind handlers ──
  const {
    handleRewindConfirm, handleRewindCancel,
    handleOpenRewindSelectDialog, handleRewindSelect, handleRewindSelectCancel,
  } = useRewindHandlers({
    t, addToast, currentSessionId, mergedMessages, getMessageText,
    setCurrentRewindRequest, setRewindDialogOpen, setRewindSelectDialogOpen,
    setIsRewinding, isRewinding,
  });

  return {
    // Computed message data
    sessionTitle, mergedMessages, getMessageText, getContentBlocks,
    findToolResult, getToolResultRaw, subagents, globalTodos,
    filteredFileChanges, rewindableMessages,
    subagentHistoryCtxValue, sessionIdCtxValue,
    // Refs
    chatInputRef, messagesContainerRef, messagesEndRef, inputAreaRef, isAutoScrollingRef,
    // Message actions
    handleUndoFile, onDiscardAll, handleKeepAll,
    handleSubmit, interruptSession, messageQueue, dequeueMessage,
    handleOpenRewindSelectDialog, handleNavigateToProviderSettings, wrappedHandleProviderSelect,
    // Session management
    createNewSession, forceCreateNewSession, loadHistorySession, deleteHistorySession, deleteHistorySessions,
    exportHistorySession, toggleFavoriteSession, updateHistoryTitle, convertToCliSession,
    showNewSessionConfirm, handleConfirmNewSession, handleCancelNewSession,
    showInterruptConfirm, handleConfirmInterrupt, handleCancelInterrupt,
    // Rewind
    handleRewindSelect, handleRewindSelectCancel, handleRewindConfirm, handleRewindCancel,
  };
};
