import { useCallback } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import type { PermissionMode, ReasoningEffort, SelectedAgent } from '../components/ChatInputBox/types';
import type { ProviderConfig } from '../types/provider';
import type { ChatInputBoxHandle } from '../components/ChatInputBox/types';
import type { ToastMessage } from '../components/Toast';

export interface UseSelectionHandlersOptions {
  t: TFunction;
  currentProvider: string;
  claudePermissionMode: PermissionMode;
  selectedClaudeModel: string;
  selectedCodexModel: string;
  activeProviderConfig: ProviderConfig | null;
  chatInputRef: React.RefObject<ChatInputBoxHandle | null>;
  setCurrentProvider: (provider: string) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setClaudePermissionMode: (mode: PermissionMode) => void;
  setSelectedClaudeModel: (model: string) => void;
  setSelectedCodexModel: (model: string) => void;
  setReasoningEffort: (effort: ReasoningEffort) => void;
  setSelectedAgent: (agent: SelectedAgent | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  setActiveProviderConfig: React.Dispatch<React.SetStateAction<ProviderConfig | null>>;
  setClaudeSettingsAlwaysThinkingEnabled: (enabled: boolean) => void;
  setStreamingEnabledSetting: (enabled: boolean) => void;
  setSendShortcut: (shortcut: 'enter' | 'cmdEnter') => void;
  addToast: (message: string, type?: ToastMessage['type']) => void;
}

export interface UseSelectionHandlersReturn {
  handleModeSelect: (mode: PermissionMode) => void;
  handleModelSelect: (modelId: string) => void;
  handleProviderSelect: (providerId: string) => void;
  handleReasoningChange: (effort: ReasoningEffort) => void;
  handleAgentSelect: (agent: SelectedAgent | null) => void;
  handleToggleThinking: (enabled: boolean) => void;
  handleStreamingEnabledChange: (enabled: boolean) => void;
  handleSendShortcutChange: (shortcut: 'enter' | 'cmdEnter') => void;
}

/**
 * Hook for mode/model/provider/agent selection handlers
 */
export function useSelectionHandlers({
  t,
  currentProvider,
  claudePermissionMode,
  selectedClaudeModel,
  selectedCodexModel,
  activeProviderConfig,
  chatInputRef,
  setCurrentProvider,
  setPermissionMode,
  setClaudePermissionMode,
  setSelectedClaudeModel,
  setSelectedCodexModel,
  setReasoningEffort,
  setSelectedAgent,
  setMessages,
  setActiveProviderConfig,
  setClaudeSettingsAlwaysThinkingEnabled,
  setStreamingEnabledSetting,
  setSendShortcut,
  addToast,
}: UseSelectionHandlersOptions): UseSelectionHandlersReturn {
  /**
   * Handle permission mode selection
   */
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      setPermissionMode('bypassPermissions');
      sendBridgeEvent('set_mode', 'bypassPermissions');
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, [currentProvider, setPermissionMode, setClaudePermissionMode]);

  /**
   * Handle model selection
   */
  const handleModelSelect = useCallback((modelId: string) => {
    if (currentProvider === 'claude') {
      setSelectedClaudeModel(modelId);
    } else if (currentProvider === 'codex') {
      setSelectedCodexModel(modelId);
    }
    sendBridgeEvent('set_model', modelId);
  }, [currentProvider, setSelectedClaudeModel, setSelectedCodexModel]);

  /**
   * Handle provider selection
   * Clears messages and input on provider switch (like new session)
   */
  const handleProviderSelect = useCallback((providerId: string) => {
    // Clear messages (like new session)
    setMessages([]);
    // Clear input
    chatInputRef.current?.clear();

    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);
    const modeToSet = providerId === 'codex' ? 'bypassPermissions' : claudePermissionMode;
    setPermissionMode(modeToSet);
    sendBridgeEvent('set_mode', modeToSet);

    // Also send the corresponding model when switching provider
    const newModel = providerId === 'codex' ? selectedCodexModel : selectedClaudeModel;
    sendBridgeEvent('set_model', newModel);
  }, [
    claudePermissionMode,
    selectedClaudeModel,
    selectedCodexModel,
    chatInputRef,
    setCurrentProvider,
    setPermissionMode,
    setMessages,
  ]);

  /**
   * Handle reasoning effort change (Codex only)
   */
  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  }, [setReasoningEffort]);

  /**
   * Handle agent selection
   */
  const handleAgentSelect = useCallback((agent: SelectedAgent | null) => {
    setSelectedAgent(agent);
    if (agent) {
      sendBridgeEvent('set_selected_agent', JSON.stringify({
        id: agent.id,
        name: agent.name,
        prompt: agent.prompt,
      }));
    } else {
      sendBridgeEvent('set_selected_agent', '');
    }
  }, [setSelectedAgent]);

  /**
   * Handle thinking mode toggle
   */
  const handleToggleThinking = useCallback((enabled: boolean) => {
    if (!activeProviderConfig) {
      setClaudeSettingsAlwaysThinkingEnabled(enabled);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    // Optimistic update
    setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled
      }
    } : null);

    // Send update to backend
    const payload = JSON.stringify({
      id: activeProviderConfig.id,
      updates: {
        settingsConfig: {
          ...(activeProviderConfig.settingsConfig || {}),
          alwaysThinkingEnabled: enabled
        }
      }
    });
    sendBridgeEvent('update_provider', payload);
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [t, activeProviderConfig, setActiveProviderConfig, setClaudeSettingsAlwaysThinkingEnabled, addToast]);

  /**
   * Handle streaming enabled toggle
   */
  const handleStreamingEnabledChange = useCallback((enabled: boolean) => {
    setStreamingEnabledSetting(enabled);
    const payload = { streamingEnabled: enabled };
    sendBridgeEvent('set_streaming_enabled', JSON.stringify(payload));
    addToast(enabled ? t('settings.basic.streaming.enabled') : t('settings.basic.streaming.disabled'), 'success');
  }, [t, setStreamingEnabledSetting, addToast]);

  /**
   * Handle send shortcut change
   */
  const handleSendShortcutChange = useCallback((shortcut: 'enter' | 'cmdEnter') => {
    setSendShortcut(shortcut);
    const payload = { sendShortcut: shortcut };
    sendBridgeEvent('set_send_shortcut', JSON.stringify(payload));
  }, [setSendShortcut]);

  return {
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleReasoningChange,
    handleAgentSelect,
    handleToggleThinking,
    handleStreamingEnabledChange,
    handleSendShortcutChange,
  };
}
