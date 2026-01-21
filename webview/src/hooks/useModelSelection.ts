import { useCallback, useEffect, useRef, useState } from 'react';
import { sendBridgeEvent } from '../utils/bridge';
import { debugLog, debugWarn, debugError } from '../utils/debugLogger';
import { CLAUDE_MODELS, CODEX_MODELS } from '../components/ChatInputBox/types';
import type { PermissionMode, ReasoningEffort, SelectedAgent, ChatInputBoxHandle } from '../components/ChatInputBox/types';
import type { ClaudeMessage } from '../types';
import type { ProviderConfig } from '../types/provider';
import type { ToastMessage } from '../components/Toast';

interface UseModelSelectionProps {
  t: (key: string) => string;
  chatInputRef: React.RefObject<ChatInputBoxHandle | null>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  addToast: (message: string, type?: ToastMessage['type']) => void;
}

interface UseModelSelectionReturn {
  // State
  currentProvider: string;
  selectedClaudeModel: string;
  selectedCodexModel: string;
  selectedModel: string;
  permissionMode: PermissionMode;
  claudePermissionMode: PermissionMode;
  reasoningEffort: ReasoningEffort;
  selectedAgent: SelectedAgent | null;
  activeProviderConfig: ProviderConfig | null;
  claudeSettingsAlwaysThinkingEnabled: boolean;
  // Refs
  currentProviderRef: React.MutableRefObject<string>;
  // Setters (exposed for external updates from window callbacks)
  setCurrentProvider: React.Dispatch<React.SetStateAction<string>>;
  setSelectedClaudeModel: React.Dispatch<React.SetStateAction<string>>;
  setSelectedCodexModel: React.Dispatch<React.SetStateAction<string>>;
  setPermissionMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  setClaudePermissionMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  setActiveProviderConfig: React.Dispatch<React.SetStateAction<ProviderConfig | null>>;
  setClaudeSettingsAlwaysThinkingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedAgent: React.Dispatch<React.SetStateAction<SelectedAgent | null>>;
  // Handlers
  handleModeSelect: (mode: PermissionMode) => void;
  handleModelSelect: (modelId: string) => void;
  handleProviderSelect: (providerId: string) => void;
  handleReasoningChange: (effort: ReasoningEffort) => void;
  handleAgentSelect: (agent: SelectedAgent | null) => void;
  handleToggleThinking: (enabled: boolean) => void;
}

/**
 * Hook for managing model and provider selection state and handlers
 * Extracts complex model selection logic from App.tsx
 */
export function useModelSelection({
  t,
  chatInputRef,
  setMessages,
  addToast,
}: UseModelSelectionProps): UseModelSelectionReturn {
  // Provider and model state
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [selectedClaudeModel, setSelectedClaudeModel] = useState(CLAUDE_MODELS[0].id);
  const [selectedCodexModel, setSelectedCodexModel] = useState(CODEX_MODELS[0].id);
  const [claudePermissionMode, setClaudePermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [selectedAgent, setSelectedAgent] = useState<SelectedAgent | null>(null);
  const [activeProviderConfig, setActiveProviderConfig] = useState<ProviderConfig | null>(null);
  const [claudeSettingsAlwaysThinkingEnabled, setClaudeSettingsAlwaysThinkingEnabled] = useState(true);

  // Ref for latest provider value to avoid closure issues in callbacks
  const currentProviderRef = useRef(currentProvider);
  useEffect(() => {
    currentProviderRef.current = currentProvider;
  }, [currentProvider]);

  // Computed selected model based on provider
  const selectedModel = currentProvider === 'codex' ? selectedCodexModel : selectedClaudeModel;

  // Load model selection state from localStorage and sync to backend
  useEffect(() => {
    try {
      const saved = localStorage.getItem('model-selection-state');
      let restoredProvider = 'claude';
      let restoredClaudeModel = CLAUDE_MODELS[0].id;
      let restoredCodexModel = CODEX_MODELS[0].id;
      let initialPermissionMode: PermissionMode = 'bypassPermissions';

      if (saved) {
        const state = JSON.parse(saved);

        // Validate and restore provider
        if (['claude', 'codex'].includes(state.provider)) {
          restoredProvider = state.provider;
          setCurrentProvider(state.provider);
          if (state.provider === 'codex') {
            initialPermissionMode = 'bypassPermissions';
          }
        }

        // Validate and restore Claude model
        if (CLAUDE_MODELS.find((m) => m.id === state.claudeModel)) {
          restoredClaudeModel = state.claudeModel;
          setSelectedClaudeModel(state.claudeModel);
        }

        // Validate and restore Codex model
        if (CODEX_MODELS.find((m) => m.id === state.codexModel)) {
          restoredCodexModel = state.codexModel;
          setSelectedCodexModel(state.codexModel);
        }
      }

      setPermissionMode(initialPermissionMode);

      // Sync model state to backend on init
      let syncRetryCount = 0;
      const MAX_SYNC_RETRIES = 30;

      const syncToBackend = () => {
        if (window.sendToJava) {
          sendBridgeEvent('set_provider', restoredProvider);
          const modelToSync = restoredProvider === 'codex' ? restoredCodexModel : restoredClaudeModel;
          sendBridgeEvent('set_model', modelToSync);
          sendBridgeEvent('set_mode', initialPermissionMode);
          debugLog('[Frontend] Synced model state to backend:', { provider: restoredProvider, model: modelToSync });
        } else {
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          } else {
            debugWarn('[Frontend] Failed to sync model state to backend: bridge not available after', MAX_SYNC_RETRIES, 'retries');
          }
        }
      };
      setTimeout(syncToBackend, 200);
    } catch (error) {
      debugError('Failed to load model selection state:', error);
    }
  }, []);

  // Save model selection state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(
        'model-selection-state',
        JSON.stringify({
          provider: currentProvider,
          claudeModel: selectedClaudeModel,
          codexModel: selectedCodexModel,
        })
      );
    } catch (error) {
      debugError('Failed to save model selection state:', error);
    }
  }, [currentProvider, selectedClaudeModel, selectedCodexModel]);

  // Load selected agent
  useEffect(() => {
    let retryCount = 0;
    const MAX_RETRIES = 10;
    let timeoutId: number | undefined;

    const loadSelectedAgent = () => {
      if (window.sendToJava) {
        sendBridgeEvent('get_selected_agent');
        debugLog('[Frontend] Requested selected agent');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          timeoutId = window.setTimeout(loadSelectedAgent, 100);
        } else {
          debugWarn('[Frontend] Failed to load selected agent: bridge not available after', MAX_RETRIES, 'retries');
        }
      }
    };

    timeoutId = window.setTimeout(loadSelectedAgent, 200);

    return () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  // Handler: Mode selection
  const handleModeSelect = useCallback(
    (mode: PermissionMode) => {
      if (currentProvider === 'codex') {
        setPermissionMode('bypassPermissions');
        sendBridgeEvent('set_mode', 'bypassPermissions');
        return;
      }
      setPermissionMode(mode);
      setClaudePermissionMode(mode);
      sendBridgeEvent('set_mode', mode);
    },
    [currentProvider]
  );

  // Handler: Model selection
  const handleModelSelect = useCallback(
    (modelId: string) => {
      if (currentProvider === 'claude') {
        setSelectedClaudeModel(modelId);
      } else if (currentProvider === 'codex') {
        setSelectedCodexModel(modelId);
      }
      sendBridgeEvent('set_model', modelId);
    },
    [currentProvider]
  );

  // Handler: Provider selection (clears messages and input like new session)
  const handleProviderSelect = useCallback(
    (providerId: string) => {
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
    },
    [claudePermissionMode, selectedCodexModel, selectedClaudeModel, chatInputRef, setMessages]
  );

  // Handler: Reasoning effort change (Codex only)
  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  }, []);

  // Handler: Agent selection
  const handleAgentSelect = useCallback((agent: SelectedAgent | null) => {
    setSelectedAgent(agent);
    if (agent) {
      sendBridgeEvent(
        'set_selected_agent',
        JSON.stringify({
          id: agent.id,
          name: agent.name,
          prompt: agent.prompt,
        })
      );
    } else {
      sendBridgeEvent('set_selected_agent', '');
    }
  }, []);

  // Handler: Toggle thinking mode
  const handleToggleThinking = useCallback(
    (enabled: boolean) => {
      if (!activeProviderConfig) {
        setClaudeSettingsAlwaysThinkingEnabled(enabled);
        sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
        addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
        return;
      }

      // Optimistic update
      setActiveProviderConfig((prev) =>
        prev
          ? {
              ...prev,
              settingsConfig: {
                ...prev.settingsConfig,
                alwaysThinkingEnabled: enabled,
              },
            }
          : null
      );

      // Send update to backend
      const payload = JSON.stringify({
        id: activeProviderConfig.id,
        updates: {
          settingsConfig: {
            ...(activeProviderConfig.settingsConfig || {}),
            alwaysThinkingEnabled: enabled,
          },
        },
      });
      sendBridgeEvent('update_provider', payload);
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
    },
    [activeProviderConfig, t, addToast]
  );

  return {
    // State
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    selectedModel,
    permissionMode,
    claudePermissionMode,
    reasoningEffort,
    selectedAgent,
    activeProviderConfig,
    claudeSettingsAlwaysThinkingEnabled,
    // Refs
    currentProviderRef,
    // Setters
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setPermissionMode,
    setClaudePermissionMode,
    setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled,
    setSelectedAgent,
    // Handlers
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleReasoningChange,
    handleAgentSelect,
    handleToggleThinking,
  };
}
