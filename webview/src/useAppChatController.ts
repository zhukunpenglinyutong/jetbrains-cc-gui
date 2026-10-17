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
  CONTEXT_COMMANDS,
} from './hooks/useMessageSender';
import { parseCodexCommand } from './hooks/codexCommandDispatcher';
import { useCodexTurnActivity } from './hooks/useCodexTurnActivity';
import { useCodexCompactionStatus } from './hooks/useCodexCompactionStatus';
import type { Attachment, ChatInputBoxHandle, PermissionMode } from './components/ChatInputBox/types';
import type { ChatScreenProps } from './components/ChatScreen';
import { useSubagentContextValues, useSetTaskEvents } from './contexts/SubagentContext';
import { useMessages } from './contexts/MessagesContext';
import { useSession } from './contexts/SessionContext';
import { useUIState } from './contexts/UIStateContext';
import { useDialogs } from './contexts/DialogContext';
import type { ApplyHistoryModel } from './applyHistoryModel';
import { useCodexPlanState } from './hooks/useCodexPlanState';

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
  codexCollaborationMode: UseMessageSenderOptions['codexCollaborationMode'];
  codexApprovalPreset: UseMessageSenderOptions['codexApprovalPreset'];
  codexSandboxSelection: UseMessageSenderOptions['codexSandboxSelection'];
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
    restoredSessionTitle, setRestoredSessionTitle,
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
    reasoningEffort, codexFastMode, codexCollaborationMode, codexApprovalPreset,
    codexSandboxSelection, dshPreset, longContextEnabled,
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

  const codexTurnActive = useCodexTurnActivity(currentProvider, currentSessionId);
  const { pending: codexCompactionPending, startedAt: codexCompactionStartedAt,
    startCompaction: startCodexCompaction } = useCodexCompactionStatus({
    provider: currentProvider, threadId: currentSessionId, t, setMessages, setLoading, setLoadingStartTime,
  });
  const {
    plan: codexPlan,
    executionPending: codexPlanExecutionPending,
    executePlan: executeCodexPlan,
  } = useCodexPlanState({
    provider: currentProvider,
    threadId: currentSessionId,
    turnActive: loading || codexTurnActive || codexCompactionPending,
  });

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
    streamingTurnIdRef, turnIdCounterRef, recordStreamingBlockReset,
    clearStreamingBlockResets,
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
    streamingTurnIdRef, turnIdCounterRef, recordStreamingBlockReset,
    clearStreamingBlockResets,
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
    setRestoredSessionTitle,
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
    interruptSession,
  } = useMessageSender({
    t, addToast,
    currentProvider, selectedModel, permissionMode, reasoningEffort, selectedAgent, codexFastMode,
    codexCollaborationMode, codexApprovalPreset, codexSandboxSelection,
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
    startCodexCompaction,
    codexCompactionPending,
  });

  // ── Message queue ──
  const {
    queue: messageQueue,
    enqueue: enqueueMessage,
    dequeue: dequeueMessage,
    clearQueue,
    reorder: reorderMessageQueue,
  } = useMessageQueue({ isLoading: loading || codexTurnActive || codexPlanExecutionPending || codexCompactionPending, onExecute: hookHandleSubmit });

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
      const parsedCommand = parseCodexCommand(text);
      // New session commands
      if (parsedCommand?.kind === 'new') {
        forceCreateNewSession();
        return;
      }
      // /resume - open history view
      if (parsedCommand?.kind === 'resume') {
        setCurrentView('history');
        return;
      }
      // /plan - switch to plan mode (Claude only; Codex sends as normal text).
      // Claude keeps the legacy behavior for `/plan <args>`: switch the mode
      // instead of leaking the literal command text to the model.
      if (parsedCommand?.kind === 'plan' && currentProvider === 'claude') {
        handleModeSelect('plan');
        addToast(t('chat.planModeEnabled', { defaultValue: 'Plan mode enabled' }), 'info');
        return;
      }
      // /context - handled locally even while loading
      if (text.split(/\s+/)[0].toLowerCase() === '/context' || CONTEXT_COMMANDS.has(text.split(/\s+/)[0].toLowerCase())) {
        hookHandleSubmit(content, attachments);
        return;
      }
      // Workspace/settings reads remain available while native work is waiting.
      if (currentProvider === 'codex' && ['diff', 'approvals'].includes(parsedCommand?.kind ?? '')) {
        hookHandleSubmit(content, attachments);
        return;
      }
    }
    // If loading, add to queue
    if (loading || codexTurnActive || codexPlanExecutionPending || codexCompactionPending) {
      enqueueMessage(content, attachments);
      return;
    }
    hookHandleSubmit(content, attachments);
  }, [loading, codexTurnActive, codexPlanExecutionPending, codexCompactionPending, enqueueMessage, hookHandleSubmit, forceCreateNewSession, currentProvider, handleModeSelect, setCurrentView, addToast, t]);

  // ── Chat-view computations (stage 5 of TASK-P1-01) ──
  const {
    findToolResult, getToolResultRaw,
    fileChangeMgmt,
    filteredFileChanges, subagents, allSubagents, globalTodos, rewindableMessages, sessionTitle,
  } = useChatComputations({
    t, messages, mergedMessages, subagentHistories, customSessionTitle, restoredSessionTitle,
    streamingActive, currentProvider,
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

  const handleContinueCodexPlan = useCallback(() => {
    if (!codexPlan?.text || currentProvider !== 'codex') return;
    chatInputRef.current?.setValue(
      `${t('chat.continueRefiningPlan', { defaultValue: 'Continue refining this plan:' })}\n\n${codexPlan.text}`);
    chatInputRef.current?.focus();
  }, [codexPlan, currentProvider, t]);

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
    findToolResult, getToolResultRaw, subagents, allSubagents, globalTodos,
    filteredFileChanges, rewindableMessages,
    subagentHistoryCtxValue, sessionIdCtxValue,
    // Refs
    chatInputRef, messagesContainerRef, messagesEndRef, inputAreaRef, isAutoScrollingRef,
    // Message actions
    handleUndoFile, onDiscardAll, handleKeepAll,
    handleSubmit, interruptSession, messageQueue, dequeueMessage, reorderMessageQueue,
    handleOpenRewindSelectDialog, handleNavigateToProviderSettings, wrappedHandleProviderSelect,
    codexPlan, codexPlanExecutionPending,
    codexCompactionPending,
    onExecuteCodexPlan: executeCodexPlan,
    codexCompactionStartedAt,
    onContinueCodexPlan: handleContinueCodexPlan,
    // Session management
    createNewSession, loadHistorySession, deleteHistorySession, deleteHistorySessions,
    exportHistorySession, toggleFavoriteSession, updateHistoryTitle, convertToCliSession,
    showNewSessionConfirm, handleConfirmNewSession, handleCancelNewSession,
    showInterruptConfirm, handleConfirmInterrupt, handleCancelInterrupt,
    // Rewind
    handleRewindSelect, handleRewindSelectCancel, handleRewindConfirm, handleRewindCancel,
  };
};
