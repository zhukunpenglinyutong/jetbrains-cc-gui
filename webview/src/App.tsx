import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import HistoryView from './components/history/HistoryView';
import SettingsView from './components/settings';
import type { SettingsTab } from './components/settings/SettingsSidebar';
import ConfirmDialog from './components/ConfirmDialog';
import PermissionDialog from './components/PermissionDialog';
import AskUserQuestionDialog from './components/AskUserQuestionDialog';
import PlanApprovalDialog from './components/PlanApprovalDialog';
import RewindDialog from './components/RewindDialog';
import RewindSelectDialog from './components/RewindSelectDialog';
import { sendBridgeEvent } from './utils/bridge';
import { ChatInputBox } from './components/ChatInputBox';
import {
  useScrollBehavior,
  useDialogManagement,
  useSessionManagement,
  useStreamingMessages,
  useWindowCallbacks,
  useRewindHandlers,
  useHistoryLoader,
  useUsageStats,
  useModelSelection,
  useToastManagement,
  useThemeInitialization,
  useMessageProcessing,
  useTodoExtraction,
  useRewindable,
  useChatSubmit,
} from './hooks';
import type { ContextInfo } from './hooks';
import type { Attachment, ChatInputBoxHandle } from './components/ChatInputBox/types';
import { TodoPanel } from './components/TodoPanel';
import { ToastContainer } from './components/Toast';
import { ScrollControl } from './components/ScrollControl';
import { extractMarkdownContent } from './utils/copyUtils';
import { ChatHeader } from './components/ChatHeader';
import { WelcomeScreen } from './components/WelcomeScreen';
import { MessageList, type MessageListHandle } from './components/MessageList';
import type { ClaudeMessage, HistoryData } from './types';
import type { ProviderConfig } from './types/provider';

type ViewMode = 'chat' | 'history' | 'settings';

const App = () => {
  const { t, i18n } = useTranslation();

  // Create stable t reference, only update when language changes
  const stableT = useMemo(() => t, [i18n.language]);

  // ============================================================
  // Toast management
  // ============================================================
  const { toasts, addToast, dismissToast } = useToastManagement();

  // ============================================================
  // Theme initialization
  // ============================================================
  useThemeInitialization();

  // ============================================================
  // Dialog management
  // ============================================================
  const {
    permissionDialogOpen,
    currentPermissionRequest,
    openPermissionDialog,
    handlePermissionApprove,
    handlePermissionApproveAlways,
    handlePermissionSkip,
    askUserQuestionDialogOpen,
    currentAskUserQuestionRequest,
    openAskUserQuestionDialog,
    handleAskUserQuestionSubmit,
    handleAskUserQuestionCancel,
    planApprovalDialogOpen,
    currentPlanApprovalRequest,
    openPlanApprovalDialog,
    handlePlanApprovalApprove,
    handlePlanApprovalReject,
    rewindDialogOpen,
    setRewindDialogOpen,
    currentRewindRequest,
    setCurrentRewindRequest,
    isRewinding,
    setIsRewinding,
    rewindSelectDialogOpen,
    setRewindSelectDialogOpen,
  } = useDialogManagement({ t });

  // ============================================================
  // Core state
  // ============================================================
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [_status, setStatus] = useState('ready');
  const [loading, setLoading] = useState(false);
  const [loadingStartTime, setLoadingStartTime] = useState<number | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingActive, setStreamingActive] = useState(false);
  const [currentView, setCurrentView] = useState<ViewMode>('chat');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  const [historyData, setHistoryData] = useState<HistoryData | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  // Settings state (not covered by useModelSelection)
  const [, setProviderConfigVersion] = useState(0);
  const [activeProviderConfig, setActiveProviderConfig] = useState<ProviderConfig | null>(null);
  const [streamingEnabledSetting, setStreamingEnabledSetting] = useState(true);
  const [sendShortcut, setSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');
  const [sdkStatus, setSdkStatus] = useState<Record<string, { installed?: boolean; status?: string }>>({});
  const [sdkStatusLoaded, setSdkStatusLoaded] = useState(false);
  const [usagePercentage, setUsagePercentage] = useState(0);
  const [usageUsedTokens, setUsageUsedTokens] = useState<number | undefined>(undefined);
  const [usageMaxTokens, setUsageMaxTokens] = useState<number | undefined>(undefined);

  // ============================================================
  // Refs
  // ============================================================
  const chatInputRef = useRef<ChatInputBoxHandle>(null);
  const messageListRef = useRef<MessageListHandle>(null);
  const virtuosoScrollerRef = useRef<HTMLElement | null>(null);
  const [draftInput, setDraftInput] = useState('');

  // ============================================================
  // Scroll behavior
  // ============================================================
  const {
    messagesContainerRef,
    messagesEndRef,
    inputAreaRef,
    isUserAtBottomRef,
  } = useScrollBehavior({
    currentView,
    messages,
    loading,
    streamingActive,
  });

  const handleScrollerRef = useCallback((scroller: HTMLElement | Window | null) => {
    if (scroller && scroller !== window) {
      virtuosoScrollerRef.current = scroller as HTMLElement;
    }
  }, []);

  // ============================================================
  // Streaming messages
  // ============================================================
  const {
    streamingContentRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    streamingMessageIndexRef,
    streamingTextSegmentsRef,
    activeTextSegmentIndexRef,
    streamingThinkingSegmentsRef,
    activeThinkingSegmentIndexRef,
    seenToolUseCountRef,
    contentUpdateTimeoutRef,
    thinkingUpdateTimeoutRef,
    lastContentUpdateRef,
    lastThinkingUpdateRef,
    autoExpandedThinkingKeysRef,
    findLastAssistantIndex,
    extractRawBlocks,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,
  } = useStreamingMessages();

  // ============================================================
  // Model selection (Provider, Model, Agent, etc.)
  // ============================================================
  const {
    currentProvider,
    selectedModel,
    permissionMode,
    reasoningEffort,
    selectedAgent,
    claudeSettingsAlwaysThinkingEnabled,
    currentProviderRef,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setPermissionMode,
    setClaudePermissionMode,
    setActiveProviderConfig: setActiveProviderConfigFromModel,
    setClaudeSettingsAlwaysThinkingEnabled,
    setSelectedAgent,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleReasoningChange,
    handleAgentSelect,
    handleToggleThinking,
  } = useModelSelection({
    t,
    chatInputRef,
    setMessages,
    addToast,
  });

  // Sync activeProviderConfig between local state and useModelSelection
  // The hook needs the setter but we manage the state locally for useWindowCallbacks
  useEffect(() => {
    setActiveProviderConfigFromModel(activeProviderConfig);
  }, [activeProviderConfig, setActiveProviderConfigFromModel]);

  // ============================================================
  // SDK status check
  // ============================================================
  const currentSdkInstalled = useMemo(() => {
    if (!sdkStatusLoaded) return false;
    const providerToSdk: Record<string, string> = {
      claude: 'claude-sdk',
      anthropic: 'claude-sdk',
      bedrock: 'claude-sdk',
      codex: 'codex-sdk',
      openai: 'codex-sdk',
    };
    const sdkId = providerToSdk[currentProvider] || 'claude-sdk';
    const status = sdkStatus[sdkId];
    return status?.status === 'installed' || status?.installed === true;
  }, [sdkStatusLoaded, sdkStatus, currentProvider]);

  // ============================================================
  // Provider config sync helper
  // ============================================================
  const syncActiveProviderModelMapping = useCallback((provider?: ProviderConfig | null) => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!provider || !provider.settingsConfig || !provider.settingsConfig.env) {
      try {
        window.localStorage.removeItem('claude-model-mapping');
      } catch {
        // Ignore errors
      }
      return;
    }
    const env = provider.settingsConfig.env as Record<string, any>;
    const mapping = {
      main: env.ANTHROPIC_MODEL ?? '',
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
    };
    const hasValue = Object.values(mapping).some(v => v && String(v).trim().length > 0);
    try {
      if (hasValue) {
        window.localStorage.setItem('claude-model-mapping', JSON.stringify(mapping));
      } else {
        window.localStorage.removeItem('claude-model-mapping');
      }
    } catch {
      // Ignore errors
    }
  }, []);

  // ============================================================
  // Session management
  // ============================================================
  const {
    showNewSessionConfirm,
    showInterruptConfirm,
    suppressNextStatusToastRef,
    createNewSession,
    handleConfirmNewSession,
    handleCancelNewSession,
    handleConfirmInterrupt,
    handleCancelInterrupt,
    loadHistorySession,
    deleteHistorySession,
    exportHistorySession,
    toggleFavoriteSession,
    updateHistoryTitle,
  } = useSessionManagement({
    messages,
    loading,
    historyData,
    currentSessionId,
    setHistoryData,
    setMessages,
    setCurrentView,
    setCurrentSessionId,
    setUsagePercentage,
    setUsageUsedTokens,
    addToast,
    t,
  });

  // ============================================================
  // History loader and usage stats
  // ============================================================
  useHistoryLoader({ currentView, currentProvider });
  useUsageStats();

  // ============================================================
  // Window callbacks
  // ============================================================
  useWindowCallbacks({
    t,
    addToast,
    setMessages,
    setStatus,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
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
  });

  // ============================================================
  // Scroll to bottom when switching back to chat view
  // ============================================================
  useEffect(() => {
    if (currentView === 'chat') {
      const timer = setTimeout(() => {
        messageListRef.current?.scrollToBottom();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [currentView]);

  // ============================================================
  // Message processing
  // ============================================================
  const {
    getMessageText,
    getContentBlocks,
    findToolResult,
    mergedMessages,
  } = useMessageProcessing({
    messages,
    currentSessionId,
    stableT,
  });

  // ============================================================
  // Chat submit
  // ============================================================
  const { handleSubmit: handleSubmitFromHook } = useChatSubmit({
    t,
    loading,
    sdkStatusLoaded,
    currentSdkInstalled,
    currentProvider,
    selectedAgent,
    chatInputRef,
    isUserAtBottomRef,
    messagesContainerRef,
    setMessages,
    setLoading,
    setLoadingStartTime,
    setSettingsInitialTab: (tab) => setSettingsInitialTab(tab),
    setCurrentView,
    addToast,
  });

  // Wrap handleSubmit to use messageListRef for scrolling
  const handleSubmit = useCallback((content: string, attachments?: Attachment[]) => {
    handleSubmitFromHook(content, attachments);
    // Force scroll to bottom after sending
    requestAnimationFrame(() => {
      messageListRef.current?.scrollToBottom();
    });
  }, [handleSubmitFromHook]);

  // ============================================================
  // Rewindable messages
  // ============================================================
  const { rewindableMessages } = useRewindable({
    mergedMessages,
    currentProvider,
    getContentBlocks,
    getMessageText,
  });

  // ============================================================
  // Rewind handlers
  // ============================================================
  const {
    handleRewindConfirm,
    handleRewindCancel,
    handleOpenRewindSelectDialog,
    handleRewindSelect,
    handleRewindSelectCancel,
  } = useRewindHandlers({
    t,
    addToast,
    currentSessionId,
    mergedMessages,
    getMessageText,
    setCurrentRewindRequest,
    setRewindDialogOpen,
    setRewindSelectDialogOpen,
    setIsRewinding,
    isRewinding,
  });

  // ============================================================
  // Todo extraction
  // ============================================================
  const { globalTodos } = useTodoExtraction({
    messages,
    getContentBlocks,
  });

  // ============================================================
  // Streaming settings handlers
  // ============================================================
  const handleStreamingEnabledChange = useCallback((enabled: boolean) => {
    setStreamingEnabledSetting(enabled);
    const payload = { streamingEnabled: enabled };
    sendBridgeEvent('set_streaming_enabled', JSON.stringify(payload));
    addToast(enabled ? t('settings.basic.streaming.enabled') : t('settings.basic.streaming.disabled'), 'success');
  }, [t, addToast]);

  const handleSendShortcutChange = useCallback((shortcut: 'enter' | 'cmdEnter') => {
    setSendShortcut(shortcut);
    const payload = { sendShortcut: shortcut };
    sendBridgeEvent('set_send_shortcut', JSON.stringify(payload));
  }, []);

  // ============================================================
  // Interrupt session
  // ============================================================
  const interruptSession = useCallback(() => {
    setLoading(false);
    setLoadingStartTime(null);
    setStreamingActive(false);
    isStreamingRef.current = false;
    sendBridgeEvent('interrupt_session');
  }, [isStreamingRef]);

  // ============================================================
  // Session title
  // ============================================================
  const sessionTitle = useMemo(() => {
    if (messages.length === 0) {
      return t('common.newSession');
    }
    const firstUserMessage = messages.find((message) => message.type === 'user');
    if (!firstUserMessage) {
      return t('common.newSession');
    }
    const text = getMessageText(firstUserMessage);
    return text.length > 15 ? `${text.substring(0, 15)}...` : text;
  }, [messages, t, getMessageText]);

  // ============================================================
  // Render
  // ============================================================
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
        />
      ) : currentView === 'chat' ? (
        <>
          <div className="messages-container" ref={messagesContainerRef}>
            {messages.length === 0 && (
              <WelcomeScreen
                currentProvider={currentProvider}
                t={t}
                onProviderChange={handleProviderSelect}
              />
            )}

            <MessageList
              ref={messageListRef}
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
              onAtBottomStateChange={(atBottom) => {
                isUserAtBottomRef.current = atBottom;
              }}
              onScrollerRef={handleScrollerRef}
            />
          </div>

          <ScrollControl
            containerRef={virtuosoScrollerRef}
            inputAreaRef={inputAreaRef}
            messageListRef={messageListRef}
          />
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
          {globalTodos.length > 0 && <TodoPanel todos={globalTodos} isStreaming={streamingActive || loading} />}
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
              onProviderSelect={handleProviderSelect}
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
              hasMessages={messages.length > 0}
              onRewind={handleOpenRewindSelectDialog}
              addToast={addToast}
            />
          </div>
        </>
      )}

      <div id="image-preview-root" />

      <ConfirmDialog
        isOpen={showNewSessionConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmNewSession')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={handleConfirmNewSession}
        onCancel={handleCancelNewSession}
      />

      <ConfirmDialog
        isOpen={showInterruptConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmInterrupt')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={handleConfirmInterrupt}
        onCancel={handleCancelInterrupt}
      />

      <PermissionDialog
        isOpen={permissionDialogOpen}
        request={currentPermissionRequest}
        onApprove={handlePermissionApprove}
        onSkip={handlePermissionSkip}
        onApproveAlways={handlePermissionApproveAlways}
      />

      <AskUserQuestionDialog
        isOpen={askUserQuestionDialogOpen}
        request={currentAskUserQuestionRequest}
        onSubmit={handleAskUserQuestionSubmit}
        onCancel={handleAskUserQuestionCancel}
      />

      <PlanApprovalDialog
        isOpen={planApprovalDialogOpen}
        request={currentPlanApprovalRequest}
        onApprove={handlePlanApprovalApprove}
        onReject={handlePlanApprovalReject}
      />

      <RewindSelectDialog
        isOpen={rewindSelectDialogOpen}
        rewindableMessages={rewindableMessages}
        onSelect={handleRewindSelect}
        onCancel={handleRewindSelectCancel}
      />

      <RewindDialog
        isOpen={rewindDialogOpen}
        request={currentRewindRequest}
        isLoading={isRewinding}
        onConfirm={handleRewindConfirm}
        onCancel={handleRewindCancel}
      />
    </>
  );
};

export default App;
