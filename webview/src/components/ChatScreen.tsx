import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatInputBox } from './ChatInputBox';
import type {
  Attachment,
  ChatInputBoxHandle,
} from './ChatInputBox/types';
import { MessageAnchorRail } from './MessageAnchorRail';
import { MessageList } from './MessageList';
import { ScrollControl } from './ScrollControl';
import { StatusPanel, StatusPanelErrorBoundary } from './StatusPanel';
import { WelcomeScreen } from './WelcomeScreen';
import {
  SessionIdContext,
  SubagentHistoryContext,
  ToolResultRawContext,
} from '../contexts/SubagentContext';
import { useMessages } from '../contexts/MessagesContext';
import { useSession } from '../contexts/SessionContext';
import { useUIState } from '../contexts/UIStateContext';
import { extractMarkdownContent } from '../utils/copyUtils';
import type { ClaudeMessage, TodoItem, ToolResultBlock } from '../types';
import type { useMessageProcessing, useFileChanges, useSubagents, useFileChangesManagement, useModelProviderState, useMessageQueue } from '../hooks';
import type { GetToolResultRawFn } from '../contexts/SubagentContext';

type SubagentHistoryGetter = (key: string) => ReturnType<typeof useMessages>['subagentHistories'][string] | undefined;
type ProviderState = ReturnType<typeof useModelProviderState>;
type MessageQueueValue = ReturnType<typeof useMessageQueue>['queue'];
type SubagentList = ReturnType<typeof useSubagents>;
type FileChangeList = ReturnType<typeof useFileChanges>;
type FileChangeMgmt = ReturnType<typeof useFileChangesManagement>;

export interface ChatScreenProps {
  // Computed message data
  mergedMessages: ClaudeMessage[];
  getMessageText: (message: ClaudeMessage) => string;
  getContentBlocks: ReturnType<typeof useMessageProcessing>['getContentBlocks'];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  getToolResultRaw: GetToolResultRawFn;

  // Subagent / status panel data
  subagents: SubagentList;
  globalTodos: TodoItem[];
  filteredFileChanges: FileChangeList;
  subagentHistoryCtxValue: SubagentHistoryGetter;
  sessionIdCtxValue: { currentSessionId: string | null };

  // Refs
  chatInputRef: RefObject<ChatInputBoxHandle | null>;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  inputAreaRef: RefObject<HTMLDivElement | null>;
  messageNodeMapRef: RefObject<Map<string, HTMLDivElement>>;
  userCollapsedRef: RefObject<boolean>;

  // Anchor rail
  anchorCollapsedCount: number;
  setAnchorCollapsedCount: React.Dispatch<React.SetStateAction<number>>;
  onMessageNodeRef: (id: string, node: HTMLDivElement | null) => void;

  // Status panel
  statusPanelExpanded: boolean;
  forceStatusUpdate: React.Dispatch<React.SetStateAction<number>>;
  onUndoFile: FileChangeMgmt['handleUndoFile'];
  onDiscardAll: () => void;
  onKeepAll: FileChangeMgmt['handleKeepAll'];

  // Submit / interrupt / nav
  onSubmit: (content: string, attachments?: Attachment[]) => void;
  onInterrupt: () => void;
  onRewind: () => void;
  onNavigateToProviderSettings: () => void;
  onProviderSelect: (providerId: string) => void;

  // Model / provider state (slice from useModelProviderState)
  currentProvider: ProviderState['currentProvider'];
  selectedModel: ProviderState['selectedModel'];
  permissionMode: ProviderState['permissionMode'];
  selectedAgent: ProviderState['selectedAgent'];
  sdkStatusLoaded: ProviderState['sdkStatusLoaded'];
  currentSdkInstalled: ProviderState['currentSdkInstalled'];
  activeProviderConfig: ProviderState['activeProviderConfig'];
  claudeSettingsAlwaysThinkingEnabled: ProviderState['claudeSettingsAlwaysThinkingEnabled'];
  reasoningEffort: ProviderState['reasoningEffort'];
  streamingEnabledSetting: ProviderState['streamingEnabledSetting'];
  sendShortcut: ProviderState['sendShortcut'];
  autoOpenFileEnabled: ProviderState['autoOpenFileEnabled'];
  longContextEnabled: ProviderState['longContextEnabled'];
  usagePercentage: ProviderState['usagePercentage'];
  usageUsedTokens: ProviderState['usageUsedTokens'];
  usageMaxTokens: ProviderState['usageMaxTokens'];

  // Model handlers
  onModeSelect: ProviderState['handleModeSelect'];
  onModelSelect: ProviderState['handleModelSelect'];
  onAgentSelect: ProviderState['handleAgentSelect'];
  onReasoningChange: ProviderState['handleReasoningChange'];
  onToggleThinking: ProviderState['handleToggleThinking'];
  onStreamingEnabledChange: ProviderState['handleStreamingEnabledChange'];
  onAutoOpenFileEnabledChange: ProviderState['handleAutoOpenFileEnabledChange'];
  onLongContextChange: ProviderState['handleLongContextChange'];

  // Message queue
  messageQueue: MessageQueueValue;
  onRemoveFromQueue: (id: string) => void;
}

/**
 * Renders the chat view (messages list, status panel, input box, scroll control).
 * Reads loading / streaming flags directly from MessagesContext, navigation
 * actions from UIStateContext, and currentSessionId from SessionContext to
 * avoid prop drilling those fields from App.tsx.
 *
 * Stage 5 of TASK-P1-01.
 */
export const ChatScreen = ({
  mergedMessages, getMessageText, getContentBlocks, findToolResult, getToolResultRaw,
  subagents, globalTodos, filteredFileChanges,
  subagentHistoryCtxValue, sessionIdCtxValue,
  chatInputRef, messagesContainerRef, messagesEndRef, inputAreaRef,
  messageNodeMapRef, userCollapsedRef,
  anchorCollapsedCount, setAnchorCollapsedCount, onMessageNodeRef,
  statusPanelExpanded, forceStatusUpdate,
  onUndoFile, onDiscardAll, onKeepAll,
  onSubmit, onInterrupt, onRewind,
  onNavigateToProviderSettings, onProviderSelect,
  currentProvider, selectedModel, permissionMode, selectedAgent,
  sdkStatusLoaded, currentSdkInstalled,
  activeProviderConfig, claudeSettingsAlwaysThinkingEnabled,
  reasoningEffort, streamingEnabledSetting, sendShortcut, autoOpenFileEnabled,
  longContextEnabled, usagePercentage, usageUsedTokens, usageMaxTokens,
  onModeSelect, onModelSelect, onAgentSelect, onReasoningChange, onToggleThinking,
  onStreamingEnabledChange,
  onAutoOpenFileEnabledChange, onLongContextChange,
  messageQueue, onRemoveFromQueue,
}: ChatScreenProps) => {
  const { t } = useTranslation();
  const { messages, loading, isThinking, streamingActive, loadingStartTime, subagentHistories } = useMessages();
  const { currentSessionId } = useSession();
  const {
    setSettingsInitialTab, setCurrentView,
    contextInfo, setContextInfo,
    setAddModelDialogOpen,
    addToast,
    draftInput, setDraftInput,
    openChangelogDialog,
  } = useUIState();

  return (
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
              onProviderChange={onProviderSelect}
              onVersionClick={openChangelogDialog}
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
                  onMessageNodeRef={onMessageNodeRef}
                  onCollapsedCountChange={setAnchorCollapsedCount}
                  onNavigateToProviderSettings={onNavigateToProviderSettings}
                  currentProvider={currentProvider}
                />
              </ToolResultRawContext.Provider>
            </SubagentHistoryContext.Provider>
          </SessionIdContext.Provider>
        </div>
      </div>

      <ScrollControl containerRef={messagesContainerRef} inputAreaRef={inputAreaRef} />

      <StatusPanelErrorBoundary>
        <StatusPanel
          todos={globalTodos}
          fileChanges={filteredFileChanges}
          subagents={subagents}
          subagentHistories={subagentHistories}
          currentSessionId={currentSessionId}
          expanded={statusPanelExpanded}
          isStreaming={streamingActive}
          onUndoFile={onUndoFile}
          onDiscardAll={onDiscardAll}
          onKeepAll={onKeepAll}
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
          onSubmit={onSubmit}
          onStop={onInterrupt}
          onModeSelect={onModeSelect}
          onModelSelect={onModelSelect}
          onProviderSelect={onProviderSelect}
          reasoningEffort={reasoningEffort}
          onReasoningChange={onReasoningChange}
          onToggleThinking={onToggleThinking}
          streamingEnabled={streamingEnabledSetting}
          onStreamingEnabledChange={onStreamingEnabledChange}
          sendShortcut={sendShortcut}
          selectedAgent={selectedAgent}
          onAgentSelect={onAgentSelect}
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
          onRewind={onRewind}
          statusPanelExpanded={statusPanelExpanded}
          onToggleStatusPanel={() => {
            userCollapsedRef.current = !userCollapsedRef.current;
            forceStatusUpdate((c) => c + 1);
          }}
          addToast={addToast}
          messageQueue={messageQueue}
          onRemoveFromQueue={onRemoveFromQueue}
          autoOpenFileEnabled={autoOpenFileEnabled}
          onAutoOpenFileEnabledChange={onAutoOpenFileEnabledChange}
          longContextEnabled={longContextEnabled}
          onLongContextChange={onLongContextChange}
        />
      </div>
    </>
  );
};

