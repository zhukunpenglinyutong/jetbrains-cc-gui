import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { useModelProviderState } from '../hooks';

type ProviderState = ReturnType<typeof useModelProviderState>;

/**
 * ChatScreen-facing slice of useModelProviderState. Contains only the state
 * fields and handlers that ChatScreen and its children (ChatInputBox,
 * WelcomeScreen, MessageList, StatusPanel) need — excluding internal setters
 * and refs consumed only by App-level hooks (useWindowCallbacks,
 * useMessageSender, useSessionManagement).
 */
export interface ModelProviderContextValue {
  // Provider / model state
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

  // Usage / token state
  usagePercentage: ProviderState['usagePercentage'];
  usageUsedTokens: ProviderState['usageUsedTokens'];
  usageMaxTokens: ProviderState['usageMaxTokens'];
  tokenDetail: ProviderState['tokenDetail'];

  // Handlers
  handleModeSelect: ProviderState['handleModeSelect'];
  handleModelSelect: ProviderState['handleModelSelect'];
  handleAgentSelect: ProviderState['handleAgentSelect'];
  handleReasoningChange: ProviderState['handleReasoningChange'];
  handleToggleThinking: ProviderState['handleToggleThinking'];
  handleStreamingEnabledChange: ProviderState['handleStreamingEnabledChange'];
  handleAutoOpenFileEnabledChange: ProviderState['handleAutoOpenFileEnabledChange'];
  handleLongContextChange: ProviderState['handleLongContextChange'];
}

const ModelProviderContext = createContext<ModelProviderContextValue | null>(null);

/**
 * Provides model/provider state and handlers to the chat view tree.
 * Wraps ChatScreen so that ChatInputBox, WelcomeScreen, MessageList, and
 * StatusPanel can consume model/provider data via useModelProvider() without
 * prop drilling from App.
 */
export function ModelProviderProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ModelProviderContextValue;
}) {
  const memoized = useMemo(() => value, [
    value.currentProvider,
    value.selectedModel,
    value.permissionMode,
    value.selectedAgent,
    value.sdkStatusLoaded,
    value.currentSdkInstalled,
    value.activeProviderConfig,
    value.claudeSettingsAlwaysThinkingEnabled,
    value.reasoningEffort,
    value.streamingEnabledSetting,
    value.sendShortcut,
    value.autoOpenFileEnabled,
    value.longContextEnabled,
    value.usagePercentage,
    value.usageUsedTokens,
    value.usageMaxTokens,
    value.tokenDetail,
    value.handleModeSelect,
    value.handleModelSelect,
    value.handleAgentSelect,
    value.handleReasoningChange,
    value.handleToggleThinking,
    value.handleStreamingEnabledChange,
    value.handleAutoOpenFileEnabledChange,
    value.handleLongContextChange,
  ]);

  return (
    <ModelProviderContext.Provider value={memoized}>
      {children}
    </ModelProviderContext.Provider>
  );
}

/**
 * Access model/provider state and handlers from any component inside
 * <ModelProviderProvider>. Must be called within the provider tree.
 */
export function useModelProvider(): ModelProviderContextValue {
  const ctx = useContext(ModelProviderContext);
  if (ctx === null) {
    throw new Error('useModelProvider must be used within a ModelProviderProvider');
  }
  return ctx;
}

export { ModelProviderContext };
