import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import HistoryView from './components/history/HistoryView';
import SettingsView from './components/settings';
import type { SettingsTab } from './components/settings/SettingsSidebar';
import { sendBridgeEvent } from './utils/bridge';
import { ChatInputBox } from './components/ChatInputBox';
import { preloadSlashCommands, forceRefreshPrompts } from './components/ChatInputBox/providers';
import {
  useScrollBehavior,
  useDialogManagement,
  useSessionManagement,
  useStreamingMessages,
  useWindowCallbacks,
  useRewindHandlers,
  useHistoryLoader,
  useFileChanges,
  useSubagents,
  useMessageQueue,
  useThemeInit,
  useContextActions,
  useMessageProcessing,
  useMessageSender,
  useFileChangesManagement,
  useModelProviderState,
} from './hooks';
import {
  NEW_SESSION_COMMANDS,
  RESUME_COMMANDS,
  PLAN_COMMANDS,
} from './hooks/useMessageSender';
import type { ContextInfo, ViewMode } from './hooks';
import { formatTime } from './utils/helpers';
import { extractMarkdownContent } from './utils/copyUtils';
import { applyDiffTheme, getStoredDiffTheme } from './utils/diffTheme';
import { extractTodosFromToolUse } from './utils/todoToolNormalization';
import {
  finalizeSubagentsForSettledTurn,
  finalizeTodosForSettledTurn,
  sliceLatestConversationTurn,
} from './utils/turnScope';
import type { Attachment, ChatInputBoxHandle } from './components/ChatInputBox/types';
import { StatusPanel, StatusPanelErrorBoundary } from './components/StatusPanel';
import { ToastContainer, type ToastMessage } from './components/Toast';
import { ScrollControl } from './components/ScrollControl';
import { ChatHeader } from './components/ChatHeader';
import { WelcomeScreen } from './components/WelcomeScreen';
import { MessageList } from './components/MessageList';
import { MessageAnchorRail } from './components/MessageAnchorRail';
import { SubagentHistoryContext, SessionIdContext, ToolResultRawContext, useSubagentContextValues } from './contexts/SubagentContext';
import { FILE_MODIFY_TOOL_NAMES, isToolName } from './utils/toolConstants';
import type { RewindableMessage } from './components/RewindSelectDialog';
import { AppDialogs } from './components/AppDialogs';
import { APP_VERSION } from './version/version';
import type {
  ClaudeMessage,
  ClaudeRawMessage,
  HistoryData,
  SubagentHistoryResponse,
  ToolResultBlock,
} from './types';

const DEFAULT_STATUS = 'ready';

const App = () => {
  const { t } = useTranslation();

  // ── Dialog management ──
  const {
    permissionDialogOpen, currentPermissionRequest, openPermissionDialog,
    handlePermissionApprove, handlePermissionApproveAlways, handlePermissionSkip,
    askUserQuestionDialogOpen, currentAskUserQuestionRequest, openAskUserQuestionDialog,
    handleAskUserQuestionSubmit, handleAskUserQuestionCancel,
    planApprovalDialogOpen, currentPlanApprovalRequest, openPlanApprovalDialog,
    handlePlanApprovalApprove, handlePlanApprovalReject,
    rewindDialogOpen, setRewindDialogOpen, currentRewindRequest, setCurrentRewindRequest,
    isRewinding, setIsRewinding, rewindSelectDialogOpen, setRewindSelectDialogOpen,
  } = useDialogManagement({ t });

  // ── Core state (shared across multiple hooks) ──
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [subagentHistories, setSubagentHistories] = useState<Record<string, SubagentHistoryResponse>>({});
  const [_status, setStatus] = useState(DEFAULT_STATUS);
  const [loading, setLoading] = useState(false);
  const [loadingStartTime, setLoadingStartTime] = useState<number | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingActive, setStreamingActive] = useState(false);
  const [currentView, setCurrentView] = useState<ViewMode>('chat');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  const [historyData, setHistoryData] = useState<HistoryData | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [addModelDialogOpen, setAddModelDialogOpen] = useState(false);
  const isFirstMountRef = useRef(true);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [customSessionTitle, setCustomSessionTitle] = useState<string | null>(null);
  const chatInputRef = useRef<ChatInputBoxHandle>(null);
  const [draftInput, setDraftInput] = useState('');

  // StatusPanel collapse state
  const userCollapsedRef = useRef(false);
  const [, forceStatusUpdate] = useState(0);

  // Changelog dialog state (show once per version update)
  const LAST_SEEN_VERSION_KEY = 'lastSeenChangelogVersion';
  const [showChangelogDialog, setShowChangelogDialog] = useState(() => {
    const lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
    return lastSeen !== APP_VERSION;
  });
  const handleCloseChangelog = useCallback(() => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION);
    setShowChangelogDialog(false);
  }, []);

  // Context state (active file and selection)
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  // Refs for stale closure prevention
  const currentSessionIdRef = useRef(currentSessionId);
  useEffect(() => { currentSessionIdRef.current = currentSessionId; }, [currentSessionId]);
  const customSessionTitleRef = useRef(customSessionTitle);
  useEffect(() => { customSessionTitleRef.current = customSessionTitle; }, [customSessionTitle]);

  // Message anchor node registry for anchor rail navigation
  const messageNodeMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [anchorCollapsedCount, setAnchorCollapsedCount] = useState(0);
  const handleMessageNodeRef = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) { messageNodeMapRef.current.set(id, node); }
    else { messageNodeMapRef.current.delete(id); }
  }, []);

  // ── Theme & context actions ──
  useThemeInit();
  useContextActions();

  // Apply diff theme on app startup so diff styles work before opening Settings.
  useEffect(() => {
    const ideTheme = window.__INITIAL_IDE_THEME__ ?? null;
    applyDiffTheme(getStoredDiffTheme(), ideTheme);
  }, []);

  // ── Scroll behavior ──
  const {
    messagesContainerRef, messagesEndRef, inputAreaRef,
    isUserAtBottomRef, userPausedRef,
  } = useScrollBehavior({ currentView, messages, loading, streamingActive });

  // ── Streaming messages ──
  const {
    streamingContentRef, isStreamingRef, useBackendStreamingRenderRef,
    streamingMessageIndexRef, streamingTextSegmentsRef, activeTextSegmentIndexRef,
    streamingThinkingSegmentsRef, activeThinkingSegmentIndexRef,
    seenToolUseCountRef, contentUpdateTimeoutRef, thinkingUpdateTimeoutRef,
    lastContentUpdateRef, lastThinkingUpdateRef, autoExpandedThinkingKeysRef,
    streamingTurnIdRef, turnIdCounterRef,
    findLastAssistantIndex, extractRawBlocks,
    getOrCreateStreamingAssistantIndex, patchAssistantForStreaming,
  } = useStreamingMessages();

  // ── Toast helpers ──
  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    if (message === DEFAULT_STATUS || !message) return;
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);
  const clearToasts = useCallback(() => { setToasts([]); }, []);

  // ── Model/Provider state ──
  const {
    currentProvider, selectedModel, permissionMode,
    selectedAgent, sdkStatusLoaded, currentSdkInstalled,
    currentProviderRef,
    activeProviderConfig, claudeSettingsAlwaysThinkingEnabled,
    reasoningEffort, streamingEnabledSetting, sendShortcut, autoOpenFileEnabled,
    longContextEnabled,
    usagePercentage, usageUsedTokens, usageMaxTokens,
    setPermissionMode,
    setClaudePermissionMode, setCodexPermissionMode,
    setSelectedClaudeModel, setSelectedCodexModel,
    setProviderConfigVersion, setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled, setStreamingEnabledSetting,
    setSendShortcut, setAutoOpenFileEnabled,
    setSdkStatus, setSdkStatusLoaded, setSelectedAgent,
    setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    syncActiveProviderModelMapping,
    handleModeSelect, handleModelSelect, handleProviderSelect,
    handleReasoningChange, handleAgentSelect, handleToggleThinking,
    handleStreamingEnabledChange, handleSendShortcutChange,
    handleAutoOpenFileEnabledChange, handleLongContextChange,
  } = useModelProviderState({ addToast, t });

  // ── Global drag event interception ──
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); };
    document.addEventListener('dragover', prevent);
    document.addEventListener('drop', prevent);
    document.addEventListener('dragenter', prevent);
    return () => {
      document.removeEventListener('dragover', prevent);
      document.removeEventListener('drop', prevent);
      document.removeEventListener('dragenter', prevent);
    };
  }, []);

  // ── Slash command preloading ──
  useEffect(() => {
    preloadSlashCommands();
    forceRefreshPrompts();
    const retryTimer = setTimeout(() => { forceRefreshPrompts(); }, 1000);
    return () => clearTimeout(retryTimer);
  }, []);

  useEffect(() => {
    if (isFirstMountRef.current) { isFirstMountRef.current = false; return; }
    if (currentView === 'chat') { forceRefreshPrompts(); }
  }, [currentView]);

  // ── Session management ──
  const {
    showNewSessionConfirm, showInterruptConfirm,
    suppressNextStatusToastRef,
    createNewSession, forceCreateNewSession,
    handleConfirmNewSession, handleCancelNewSession,
    handleConfirmInterrupt, handleCancelInterrupt,
    loadHistorySession, deleteHistorySession, exportHistorySession,
    toggleFavoriteSession, updateHistoryTitle,
  } = useSessionManagement({
    messages, loading, historyData, currentSessionId,
    setHistoryData, setMessages, setCurrentView, setCurrentSessionId,
    setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setStatus, setLoading, setIsThinking, setStreamingActive,
    clearToasts, addToast, t,
  });

  useHistoryLoader({ currentView, currentProvider });

  // ── Window callbacks (bridge communication) ──
  useWindowCallbacks({
    t, addToast, clearToasts,
    setMessages, setStatus, setLoading, setLoadingStartTime,
    setIsThinking, setStreamingActive, setHistoryData,
    setCurrentSessionId, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens,
    setPermissionMode, setClaudePermissionMode, setCodexPermissionMode,
    setSelectedClaudeModel, setSelectedCodexModel,
    setProviderConfigVersion, setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled, setStreamingEnabledSetting,
    setSendShortcut, setAutoOpenFileEnabled,
    setSdkStatus, setSdkStatusLoaded,
    setIsRewinding, setRewindDialogOpen, setCurrentRewindRequest,
    setContextInfo, setSelectedAgent,
    setSubagentHistories,
    currentProviderRef, messagesContainerRef, isUserAtBottomRef, userPausedRef,
    suppressNextStatusToastRef,
    streamingContentRef, isStreamingRef, useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingTextSegmentsRef, activeTextSegmentIndexRef,
    streamingThinkingSegmentsRef, activeThinkingSegmentIndexRef,
    seenToolUseCountRef, streamingMessageIndexRef,
    streamingTurnIdRef, turnIdCounterRef,
    lastContentUpdateRef, contentUpdateTimeoutRef,
    lastThinkingUpdateRef, thinkingUpdateTimeoutRef,
    findLastAssistantIndex, extractRawBlocks,
    getOrCreateStreamingAssistantIndex, patchAssistantForStreaming,
    syncActiveProviderModelMapping,
    openPermissionDialog, openAskUserQuestionDialog, openPlanApprovalDialog,
    customSessionTitleRef, currentSessionIdRef, updateHistoryTitle,
  });

  // ── Message processing ──
  const {
    getMessageText, getContentBlocks,
    mergedMessages, sentAttachmentsRef,
  } = useMessageProcessing({ messages, currentSessionId, t });

  // Find tool result (stable ref to avoid re-renders).
  // Also populates toolResultRawMap so downstream code can look up the
  // enclosing raw message without carrying it on every result object.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const toolResultRawMapRef = useRef<Map<string, ClaudeRawMessage>>(new Map());
  const findToolResult = useCallback((toolUseId?: string, messageIndex?: number): ToolResultBlock | null => {
    if (!toolUseId || typeof messageIndex !== 'number') return null;
    const currentMessages = messagesRef.current;
    // Check the cache first — the raw message for a given tool_use_id never
    // changes once written, so a cache hit avoids a full scan.
    const cachedRaw = toolResultRawMapRef.current.get(toolUseId);
    if (cachedRaw != null) {
      const content = cachedRaw.content ?? cachedRaw.message?.content;
      if (Array.isArray(content)) {
        const hit = content.find(
          (block): block is ToolResultBlock =>
            Boolean(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId,
        );
        if (hit) return hit;
      }
    }
    for (let i = 0; i < currentMessages.length; i += 1) {
      const candidate = currentMessages[i];
      const raw = candidate.raw;
      if (!raw || typeof raw === 'string') continue;
      const content = raw.content ?? raw.message?.content;
      if (!Array.isArray(content)) continue;
      const resultBlock = content.find(
        (block): block is ToolResultBlock =>
          Boolean(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId,
      );
      if (resultBlock) {
        toolResultRawMapRef.current.set(toolUseId, raw);
        return resultBlock;
      }
    }
    return null;
  }, []);
  const getToolResultRaw = useCallback((toolUseId: string): ClaudeRawMessage | null =>
    toolResultRawMapRef.current.get(toolUseId) ?? null, []);

  // ── Message sender ──
  // Wrap handleProviderSelect to also clear messages and input (like creating a new session)
  const wrappedHandleProviderSelect = useCallback((providerId: string) => {
    setMessages([]);
    chatInputRef.current?.clear();
    handleProviderSelect(providerId);
  }, [handleProviderSelect]);

  const {
    handleSubmit: hookHandleSubmit,
    executeMessage,
    interruptSession,
  } = useMessageSender({
    t, addToast,
    currentProvider, permissionMode, selectedAgent,
    sdkStatusLoaded, currentSdkInstalled,
    sentAttachmentsRef, chatInputRef, messagesContainerRef,
    isUserAtBottomRef, userPausedRef, isStreamingRef,
    setMessages, setLoading, setLoadingStartTime, setStreamingActive,
    setSettingsInitialTab, setCurrentView,
    forceCreateNewSession,
    handleModeSelect,
  });

  // ── Message queue ──
  const {
    queue: messageQueue,
    enqueue: enqueueMessage,
    dequeue: dequeueMessage,
  } = useMessageQueue({ isLoading: loading, onExecute: executeMessage });

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
      // /plan - switch to plan mode
      if (PLAN_COMMANDS.has(command)) {
        if (currentProvider === 'codex') {
          addToast(t('chat.planModeNotAvailableForCodex', { defaultValue: 'Plan mode is not available for Codex provider' }), 'warning');
        } else {
          handleModeSelect('plan');
          addToast(t('chat.planModeEnabled', { defaultValue: 'Plan mode enabled' }), 'info');
        }
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

  // ── File changes management ──
  const {
    processedFiles, baseMessageIndex,
    handleUndoFile, handleDiscardAll: handleDiscardAllRaw, handleKeepAll,
  } = useFileChangesManagement({
    currentSessionId, currentSessionIdRef, messages,
    getContentBlocks, findToolResult,
  });

  const fileChanges = useFileChanges({
    messages, getContentBlocks, findToolResult,
    startFromIndex: baseMessageIndex,
  });

  const filteredFileChanges = useMemo(() => {
    if (processedFiles.length === 0) return fileChanges;
    return fileChanges.filter(fc => !processedFiles.includes(fc.filePath));
  }, [fileChanges, processedFiles]);

  const onDiscardAll = useCallback(() => {
    handleDiscardAllRaw(filteredFileChanges);
  }, [handleDiscardAllRaw, filteredFileChanges]);

  const latestTurnMessages = useMemo(() => sliceLatestConversationTurn(messages), [messages]);

  // ── Subagents ──
  const latestTurnSubagents = useSubagents({ messages: latestTurnMessages, getContentBlocks, findToolResult, getToolResultRaw });
  const subagents = useMemo(
    () => finalizeSubagentsForSettledTurn(latestTurnSubagents, streamingActive),
    [latestTurnSubagents, streamingActive],
  );

  // Stabilize context value references — prevents consumers from re-rendering
  // when App re-renders for unrelated reasons (e.g. streaming messages change).
  // subagentHistoryCtxValue is a getter function backed by a ref, so its
  // reference never changes even when individual histories are updated.
  const { subagentHistoryCtxValue, sessionIdCtxValue } = useSubagentContextValues(subagentHistories, currentSessionId);

  // Stable callback to avoid defeating MessageList memo on every App render.
  const handleNavigateToProviderSettings = useCallback(() => {
    setSettingsInitialTab('providers');
    setCurrentView('settings');
  }, []);

  // ── Rewind handlers ──
  const {
    handleRewindConfirm, handleRewindCancel,
    handleOpenRewindSelectDialog, handleRewindSelect, handleRewindSelectCancel,
  } = useRewindHandlers({
    t, addToast, currentSessionId, mergedMessages, getMessageText,
    setCurrentRewindRequest, setRewindDialogOpen, setRewindSelectDialogOpen,
    setIsRewinding, isRewinding,
  });

  // ── Computed values ──

  // Extract todos from the latest turn only so the status panel reflects the
  // current/most-recent task, instead of accumulating historical plans forever.
  const globalTodos = useMemo(() => {
    let latestTodos: ReturnType<typeof extractTodosFromToolUse> = null;
    for (let i = latestTurnMessages.length - 1; i >= 0; i--) {
      const msg = latestTurnMessages[i];
      if (msg.type !== 'assistant') continue;
      const blocks = getContentBlocks(msg);
      for (let j = blocks.length - 1; j >= 0; j--) {
        const todos = extractTodosFromToolUse(blocks[j]);
        if (todos && todos.length > 0) {
          latestTodos = todos;
          break;
        }
      }
      if (latestTodos) {
        break;
      }
    }
    return finalizeTodosForSettledTurn(latestTodos ?? [], streamingActive);
  }, [latestTurnMessages, getContentBlocks, streamingActive]);

  const canRewindFromMessageIndex = (userMessageIndex: number) => {
    if (userMessageIndex < 0 || userMessageIndex >= mergedMessages.length) return false;
    const current = mergedMessages[userMessageIndex];
    if (current.type !== 'user') return false;
    if ((current.content || '').trim() === '[tool_result]') return false;
    const raw = current.raw;
    if (raw && typeof raw !== 'string') {
      const content = (raw as any).content ?? (raw as any).message?.content;
      if (Array.isArray(content) && content.some((block: any) => block && block.type === 'tool_result')) {
        return false;
      }
    }
    for (let i = userMessageIndex + 1; i < mergedMessages.length; i += 1) {
      const msg = mergedMessages[i];
      if (msg.type === 'user') break;
      const blocks = getContentBlocks(msg);
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue;
        if (isToolName(block.name, FILE_MODIFY_TOOL_NAMES)) return true;
      }
    }
    return false;
  };

  const rewindableMessages = useMemo((): RewindableMessage[] => {
    if (currentProvider !== 'claude') return [];
    const result: RewindableMessage[] = [];
    for (let i = 0; i < mergedMessages.length - 1; i++) {
      if (!canRewindFromMessageIndex(i)) continue;
      const message = mergedMessages[i];
      const content = message.content || getMessageText(message);
      const timestamp = message.timestamp ? formatTime(message.timestamp) : undefined;
      const messagesAfterCount = mergedMessages.length - i - 1;
      result.push({ messageIndex: i, message, displayContent: content, timestamp, messagesAfterCount });
    }
    return result;
  }, [mergedMessages, currentProvider]);

  const statusPanelExpanded = !userCollapsedRef.current;

  const sessionTitle = useMemo(() => {
    if (customSessionTitle) return customSessionTitle;
    if (messages.length === 0) return t('common.newSession');
    const firstUserMessage = messages.find((message) => message.type === 'user');
    if (!firstUserMessage) return t('common.newSession');
    const text = getMessageText(firstUserMessage);
    return text.length > 15 ? `${text.substring(0, 15)}...` : text;
  }, [customSessionTitle, messages, t, getMessageText]);

  // ── Render ──
  return (
    <>
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      <ChatHeader
        currentView={currentView}
        sessionTitle={sessionTitle}
        t={t}
        onBack={() => setCurrentView('chat')}
        onNewSession={createNewSession}
        onNewTab={() => sendBridgeEvent('create_new_tab')}
        onHistory={() => setCurrentView('history')}
        onSettings={() => {
          setSettingsInitialTab(undefined);
          setCurrentView('settings');
        }}
        titleEditable
        onTitleChange={(newTitle) => {
          setCustomSessionTitle(newTitle);
          if (currentSessionId) {
            updateHistoryTitle(currentSessionId, newTitle);
          }
        }}
      />

      {currentView === 'settings' ? (
        <SettingsView
          onClose={() => setCurrentView('chat')}
          initialTab={settingsInitialTab}
          currentProvider={currentProvider}
          streamingEnabled={streamingEnabledSetting}
          onStreamingEnabledChange={handleStreamingEnabledChange}
          sendShortcut={sendShortcut}
          onSendShortcutChange={handleSendShortcutChange}
          autoOpenFileEnabled={autoOpenFileEnabled}
          onAutoOpenFileEnabledChange={handleAutoOpenFileEnabledChange}
        />
      ) : currentView === 'chat' ? (
        <>
          <div className="messages-shell">
            <MessageAnchorRail
              messages={mergedMessages}
              collapsedCount={anchorCollapsedCount}
              containerRef={messagesContainerRef}
              messageNodeMap={messageNodeMapRef}
            />
            <div className="messages-container" ref={messagesContainerRef}>
              {messages.length === 0 && (
                <WelcomeScreen
                  currentProvider={currentProvider}
                  currentModelId={selectedModel}
                  t={t}
                  onProviderChange={wrappedHandleProviderSelect}
                  onVersionClick={() => setShowChangelogDialog(true)}
                />
              )}

              <SessionIdContext.Provider value={sessionIdCtxValue}>
                <SubagentHistoryContext.Provider value={subagentHistoryCtxValue}>
                <ToolResultRawContext.Provider value={getToolResultRaw}>
                <MessageList
                  messages={mergedMessages}
                  streamingActive={streamingActive}
                  isThinking={isThinking}
                  loading={loading}
                  loadingStartTime={loadingStartTime}
                  t={t}
                  getMessageText={getMessageText}
                  getContentBlocks={getContentBlocks}
                  findToolResult={findToolResult}
                  extractMarkdownContent={extractMarkdownContent}
                  messagesEndRef={messagesEndRef}
                  onMessageNodeRef={handleMessageNodeRef}
                  onCollapsedCountChange={setAnchorCollapsedCount}
                  onNavigateToProviderSettings={handleNavigateToProviderSettings}
                />
                </ToolResultRawContext.Provider>
                </SubagentHistoryContext.Provider>
              </SessionIdContext.Provider>
            </div>
          </div>

          {/* Scroll control button */}
          <ScrollControl containerRef={messagesContainerRef} inputAreaRef={inputAreaRef} />
        </>
      ) : (
        <HistoryView
          historyData={historyData}
          currentProvider={currentProvider}
          onLoadSession={loadHistorySession}
          onDeleteSession={deleteHistorySession}
          onExportSession={exportHistorySession}
          onToggleFavorite={toggleFavoriteSession}
          onUpdateTitle={updateHistoryTitle}
        />
      )}

      {currentView === 'chat' && (
        <>
          <StatusPanelErrorBoundary>
            <StatusPanel
              todos={globalTodos}
              fileChanges={filteredFileChanges}
              subagents={subagents}
              subagentHistories={subagentHistories}
              currentSessionId={currentSessionId}
              expanded={statusPanelExpanded}
              isStreaming={streamingActive}
              onUndoFile={handleUndoFile}
              onDiscardAll={onDiscardAll}
              onKeepAll={handleKeepAll}
            />
          </StatusPanelErrorBoundary>
          <div className="input-area" ref={inputAreaRef}>
            <ChatInputBox
              ref={chatInputRef}
              isLoading={loading}
              selectedModel={selectedModel}
              permissionMode={permissionMode}
              currentProvider={currentProvider}
              usagePercentage={usagePercentage}
              usageUsedTokens={usageUsedTokens}
              usageMaxTokens={usageMaxTokens}
              showUsage={true}
              alwaysThinkingEnabled={activeProviderConfig?.settingsConfig?.alwaysThinkingEnabled ?? claudeSettingsAlwaysThinkingEnabled}
              placeholder={sendShortcut === 'cmdEnter' ? t('chat.inputPlaceholderCmdEnter') : t('chat.inputPlaceholderEnter')}
              sdkInstalled={currentSdkInstalled}
              sdkStatusLoading={!sdkStatusLoaded}
              onInstallSdk={() => {
                setSettingsInitialTab('dependencies');
                setCurrentView('settings');
              }}
              value={draftInput}
              onInput={setDraftInput}
              onSubmit={handleSubmit}
              onStop={interruptSession}
              onModeSelect={handleModeSelect}
              onModelSelect={handleModelSelect}
              onProviderSelect={wrappedHandleProviderSelect}
              reasoningEffort={reasoningEffort}
              onReasoningChange={handleReasoningChange}
              onToggleThinking={handleToggleThinking}
              streamingEnabled={streamingEnabledSetting}
              onStreamingEnabledChange={handleStreamingEnabledChange}
              sendShortcut={sendShortcut}
              selectedAgent={selectedAgent}
              onAgentSelect={handleAgentSelect}
              activeFile={contextInfo?.file}
              selectedLines={contextInfo?.startLine !== undefined && contextInfo?.endLine !== undefined
                ? (contextInfo.startLine === contextInfo.endLine
                    ? `L${contextInfo.startLine}`
                    : `L${contextInfo.startLine}-${contextInfo.endLine}`)
                : undefined}
              onClearContext={() => setContextInfo(null)}
              onOpenAgentSettings={() => {
                setSettingsInitialTab('agents');
                setCurrentView('settings');
              }}
              onOpenPromptSettings={() => {
                setSettingsInitialTab('prompts');
                setCurrentView('settings');
              }}
              onOpenModelSettings={() => {
                setAddModelDialogOpen(true);
              }}
              hasMessages={messages.length > 0}
              onRewind={handleOpenRewindSelectDialog}
              statusPanelExpanded={statusPanelExpanded}
              onToggleStatusPanel={() => { userCollapsedRef.current = !userCollapsedRef.current; forceStatusUpdate(c => c + 1); }}
              addToast={addToast}
              messageQueue={messageQueue}
              onRemoveFromQueue={dequeueMessage}
              autoOpenFileEnabled={autoOpenFileEnabled}
              onAutoOpenFileEnabledChange={handleAutoOpenFileEnabledChange}
              longContextEnabled={longContextEnabled}
              onLongContextChange={handleLongContextChange}
            />
          </div>
        </>
      )}

      <div id="image-preview-root" />

      <AppDialogs
        t={t}
        showNewSessionConfirm={showNewSessionConfirm}
        onConfirmNewSession={handleConfirmNewSession}
        onCancelNewSession={handleCancelNewSession}
        showInterruptConfirm={showInterruptConfirm}
        onConfirmInterrupt={handleConfirmInterrupt}
        onCancelInterrupt={handleCancelInterrupt}
        permissionDialogOpen={permissionDialogOpen}
        currentPermissionRequest={currentPermissionRequest}
        onPermissionApprove={handlePermissionApprove}
        onPermissionSkip={handlePermissionSkip}
        onPermissionApproveAlways={handlePermissionApproveAlways}
        askUserQuestionDialogOpen={askUserQuestionDialogOpen}
        currentAskUserQuestionRequest={currentAskUserQuestionRequest}
        onAskUserQuestionSubmit={handleAskUserQuestionSubmit}
        onAskUserQuestionCancel={handleAskUserQuestionCancel}
        planApprovalDialogOpen={planApprovalDialogOpen}
        currentPlanApprovalRequest={currentPlanApprovalRequest}
        onPlanApprovalApprove={handlePlanApprovalApprove}
        onPlanApprovalReject={handlePlanApprovalReject}
        rewindSelectDialogOpen={rewindSelectDialogOpen}
        rewindableMessages={rewindableMessages}
        onRewindSelect={handleRewindSelect}
        onRewindSelectCancel={handleRewindSelectCancel}
        rewindDialogOpen={rewindDialogOpen}
        currentRewindRequest={currentRewindRequest}
        isRewinding={isRewinding}
        onRewindConfirm={handleRewindConfirm}
        onRewindCancel={handleRewindCancel}
        showChangelogDialog={showChangelogDialog}
        onCloseChangelog={handleCloseChangelog}
        addModelDialogOpen={addModelDialogOpen}
        onCloseAddModel={() => setAddModelDialogOpen(false)}
        currentProvider={currentProvider}
      />
    </>
  );
};

export default App;
