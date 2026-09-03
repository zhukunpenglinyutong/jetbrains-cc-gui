import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOmpRoles } from './hooks/providers/useCliModels';
import {
  useThemeInit,
  useContextActions,
  useModelProviderState,
  useLateBoundCallback,
} from './hooks';
import type { MessageListRevealHandle } from './components/ConversationSearch/types';
import { ToastContainer } from './components/Toast';
import { AppHeader } from './components/AppHeader';
import { AppSettingsOverlay } from './components/AppSettingsOverlay';
import { AppChatArea } from './components/AppChatArea';
import { AppDialogMounts } from './components/AppDialogMounts';
import { useUIState } from './contexts/UIStateContext';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from './utils/permissionDialogTimeout';
import { createApplyHistoryModel } from './applyHistoryModel';
import { useAppGlobalEffects } from './useAppGlobalEffects';
import { useAppChatController } from './useAppChatController';

const App = () => {
  const { t } = useTranslation();

  // Toast queue + current view drive the top-level layout regions below;
  // everything else from UIStateContext is consumed inside the extracted
  // components/hooks (same convention as ChatScreen / AppDialogs).
  const { toasts, dismissToast, currentView, addToast } = useUIState();

  // ── Permission dialog timeout (synced with backend config) ──
  const [permissionDialogTimeoutSeconds, setPermissionDialogTimeoutSeconds] = useState(DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);

  // StatusPanel collapse state — kept in App.tsx because forceStatusUpdate is
  // intentionally local: a tiny re-render trigger paired with userCollapsedRef.
  const userCollapsedRef = useRef(false);
  const [, forceStatusUpdate] = useState(0);

  // Message anchor node registry for anchor rail navigation
  const messageNodeMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [anchorCollapsedCount, setAnchorCollapsedCount] = useState(0);
  const handleMessageNodeRef = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) { messageNodeMapRef.current.set(id, node); }
    else { messageNodeMapRef.current.delete(id); }
  }, []);

  // Imperative handle for the in-page search panel to expand collapsed earlier messages.
  const messageListRef = useRef<MessageListRevealHandle | null>(null);

  // ── Theme & context actions ──
  useThemeInit();
  useContextActions();

  // Story 1.3 (CAP-4): useModelProviderState runs BEFORE useAppChatController,
  // so the gemini model-change conversation reset is wired through a
  // late-bound trampoline pointed at forceCreateNewSession once that hook
  // exists below (render-time assignment — same pattern as currentProviderRef;
  // trampoline contract pinned by useLateBoundCallback.test.ts).
  const geminiSessionReset = useLateBoundCallback();

  // ── Model/Provider state ──
  const model = useModelProviderState({ addToast, t, onSessionResetRequest: geminiSessionReset.call });

  // Dynamic omp model roles (listModels payload; static smol/slow/plan until
  // loaded) — needed by applyHistoryModel's omp mode⇔model unification.
  const ompRoles = useOmpRoles();

  // ── Global effects: diff theme, drag interception, search hotkey, slash
  // command preloading, task-event recovery, Fable SDK warning ──
  useAppGlobalEffects({ model });

  const applyHistoryModel = createApplyHistoryModel({ modelState: model, ompRoles });

  // ── Chat orchestration: scroll/streaming, session management, bridge window
  // callbacks, message processing/sending, queue, computations, rewind ──
  const {
    sessionTitle, mergedMessages, getMessageText, getContentBlocks,
    findToolResult, getToolResultRaw, subagents, globalTodos,
    filteredFileChanges, rewindableMessages,
    subagentHistoryCtxValue, sessionIdCtxValue,
    chatInputRef, messagesContainerRef, messagesEndRef, inputAreaRef, isAutoScrollingRef,
    handleUndoFile, onDiscardAll, handleKeepAll,
    handleSubmit, interruptSession, messageQueue, dequeueMessage,
    handleOpenRewindSelectDialog, handleNavigateToProviderSettings, wrappedHandleProviderSelect,
    createNewSession, forceCreateNewSession, loadHistorySession, deleteHistorySession, deleteHistorySessions,
    exportHistorySession, toggleFavoriteSession, updateHistoryTitle, convertToCliSession,
    showNewSessionConfirm, handleConfirmNewSession, handleCancelNewSession,
    showInterruptConfirm, handleConfirmInterrupt, handleCancelInterrupt,
    handleRewindSelect, handleRewindSelectCancel, handleRewindConfirm, handleRewindCancel,
  } = useAppChatController({ model, applyHistoryModel, setPermissionDialogTimeoutSeconds });

  // Story 1.3 (CAP-4): point the gemini model-change reset trampoline at the
  // controller's forceCreateNewSession (createNewSession would prompt for
  // confirmation; forceCreateNewSession is the no-dialog variant).
  geminiSessionReset.set(forceCreateNewSession);

  const statusPanelExpanded = !userCollapsedRef.current;

  // ── Render ──
  return (
    <>
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      <AppHeader
        sessionTitle={sessionTitle}
        onNewSession={createNewSession}
        onUpdateHistoryTitle={updateHistoryTitle}
      />

      {currentView === 'settings' ? (
        <AppSettingsOverlay
          currentProvider={model.currentProvider}
          streamingEnabled={model.streamingEnabledSetting}
          onStreamingEnabledChange={model.handleStreamingEnabledChange}
          sendShortcut={model.sendShortcut}
          onSendShortcutChange={model.handleSendShortcutChange}
          autoOpenFileEnabled={model.autoOpenFileEnabled}
          onAutoOpenFileEnabledChange={model.handleAutoOpenFileEnabledChange}
          permissionDialogTimeoutSeconds={permissionDialogTimeoutSeconds}
          onPermissionDialogTimeoutChange={setPermissionDialogTimeoutSeconds}
        />
      ) : (
        <AppChatArea
          mergedMessages={mergedMessages}
          sessionTitle={sessionTitle}
          getMessageText={getMessageText}
          getContentBlocks={getContentBlocks}
          findToolResult={findToolResult}
          getToolResultRaw={getToolResultRaw}
          subagents={subagents}
          globalTodos={globalTodos}
          filteredFileChanges={filteredFileChanges}
          subagentHistoryCtxValue={subagentHistoryCtxValue}
          sessionIdCtxValue={sessionIdCtxValue}
          chatInputRef={chatInputRef}
          messagesContainerRef={messagesContainerRef}
          messagesEndRef={messagesEndRef}
          inputAreaRef={inputAreaRef}
          messageNodeMapRef={messageNodeMapRef}
          userCollapsedRef={userCollapsedRef}
          messageListRef={messageListRef}
          isAutoScrollingRef={isAutoScrollingRef}
          anchorCollapsedCount={anchorCollapsedCount}
          setAnchorCollapsedCount={setAnchorCollapsedCount}
          onMessageNodeRef={handleMessageNodeRef}
          statusPanelExpanded={statusPanelExpanded}
          forceStatusUpdate={forceStatusUpdate}
          onUndoFile={handleUndoFile}
          onDiscardAll={onDiscardAll}
          onKeepAll={handleKeepAll}
          onSubmit={handleSubmit}
          onInterrupt={interruptSession}
          onRewind={handleOpenRewindSelectDialog}
          onNavigateToProviderSettings={handleNavigateToProviderSettings}
          onProviderSelect={wrappedHandleProviderSelect}
          currentProvider={model.currentProvider}
          selectedModel={model.selectedModel}
          permissionMode={model.permissionMode}
          codexNativeAutoReviewAvailable={model.codexNativeAutoReviewAvailable}
          selectedAgent={model.selectedAgent}
          sdkStatusLoading={model.sdkStatusLoading}
          sdkStatusError={model.sdkStatusError}
          onRetrySdkStatus={model.retrySdkStatus}
          currentSdkInstalled={model.currentSdkInstalled}
          activeProviderConfig={model.activeProviderConfig}
          claudeSettingsAlwaysThinkingEnabled={model.claudeSettingsAlwaysThinkingEnabled}
          reasoningEffort={model.reasoningEffort}
          codexFastMode={model.codexFastMode}
          dshPreset={model.dshPreset}
          streamingEnabledSetting={model.streamingEnabledSetting}
          sendShortcut={model.sendShortcut}
          autoOpenFileEnabled={model.autoOpenFileEnabled}
          longContextEnabled={model.longContextEnabled}
          usagePercentage={model.usagePercentage}
          usageUsedTokens={model.usageUsedTokens}
          usageMaxTokens={model.usageMaxTokens}
          onModeSelect={model.handleModeSelect}
          onModelSelect={model.handleModelSelect}
          onAgentSelect={model.handleAgentSelect}
          onReasoningChange={model.handleReasoningChange}
          onCodexFastModeChange={model.handleCodexFastModeChange}
          onDshPresetChange={model.handleDshPresetChange}
          onToggleThinking={model.handleToggleThinking}
          onStreamingEnabledChange={model.handleStreamingEnabledChange}
          onAutoOpenFileEnabledChange={model.handleAutoOpenFileEnabledChange}
          onLongContextChange={model.handleLongContextChange}
          messageQueue={messageQueue}
          onRemoveFromQueue={dequeueMessage}
          onLoadSession={loadHistorySession}
          onDeleteSession={deleteHistorySession}
          onDeleteSessions={deleteHistorySessions}
          onExportSession={exportHistorySession}
          onToggleFavorite={toggleFavoriteSession}
          onUpdateTitle={updateHistoryTitle}
          onConvertToCliSession={convertToCliSession}
        />
      )}

      <AppDialogMounts
        showNewSessionConfirm={showNewSessionConfirm}
        onConfirmNewSession={handleConfirmNewSession}
        onCancelNewSession={handleCancelNewSession}
        showInterruptConfirm={showInterruptConfirm}
        onConfirmInterrupt={handleConfirmInterrupt}
        onCancelInterrupt={handleCancelInterrupt}
        rewindableMessages={rewindableMessages}
        onRewindSelect={handleRewindSelect}
        onRewindSelectCancel={handleRewindSelectCancel}
        onRewindConfirm={handleRewindConfirm}
        onRewindCancel={handleRewindCancel}
        currentProvider={model.currentProvider}
        permissionDialogTimeoutSeconds={permissionDialogTimeoutSeconds}
        onModeSelect={model.handleModeSelect}
      />
    </>
  );
};

export default App;
