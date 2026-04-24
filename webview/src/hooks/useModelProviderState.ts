import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import { CLAUDE_MODELS, CODEX_MODELS, isValidPermissionMode, normalizeClaudeModelId, apply1MContextSuffix, strip1MContextSuffix } from '../components/ChatInputBox/types';
import type { PermissionMode, ReasoningEffort, SelectedAgent } from '../components/ChatInputBox/types';
import type { ProviderConfig } from '../types/provider';
import { isSpecialProviderId } from '../types/provider';
import { writeClaudeModelMapping } from '../utils/claudeModelMapping';

export type ViewMode = 'chat' | 'history' | 'settings';

const getCustomModels = (key: string): { id: string }[] => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * Manages all provider/model/permission state, initialization from localStorage,
 * sync to backend, and handler callbacks for mode/model/provider selection.
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  // ChatInputBox related state
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [selectedClaudeModel, setSelectedClaudeModel] = useState(CLAUDE_MODELS[0].id);
  const [selectedCodexModel, setSelectedCodexModel] = useState(CODEX_MODELS[0].id);
  const [claudePermissionMode, setClaudePermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [codexPermissionMode, setCodexPermissionMode] = useState<PermissionMode>('default');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  // Codex reasoning effort (thinking depth)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [usagePercentage, setUsagePercentage] = useState(0);
  const [usageUsedTokens, setUsageUsedTokens] = useState<number | undefined>(undefined);
  const [usageMaxTokens, setUsageMaxTokens] = useState<number | undefined>(undefined);
  const [, setProviderConfigVersion] = useState(0);
  const [activeProviderConfig, setActiveProviderConfig] = useState<ProviderConfig | null>(null);
  const [claudeSettingsAlwaysThinkingEnabled, setClaudeSettingsAlwaysThinkingEnabled] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<SelectedAgent | null>(null);
  // Streaming toggle state (synced with settings page)
  const [streamingEnabledSetting, setStreamingEnabledSetting] = useState(true);
  // Send shortcut setting
  const [sendShortcut, setSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');
  // Auto-open file setting
  const [autoOpenFileEnabled, setAutoOpenFileEnabled] = useState(false);
  // Long context (1M) toggle state - default enabled, persisted with model selection
  const [longContextEnabled, setLongContextEnabled] = useState(true);

  // SDK installation status
  const [sdkStatus, setSdkStatus] = useState<Record<string, { installed?: boolean; status?: string }>>({});
  const [sdkStatusLoaded, setSdkStatusLoaded] = useState(false);

  // Refs for stale closure prevention
  const currentProviderRef = useRef(currentProvider);
  const activeProviderConfigRef = useRef(activeProviderConfig);
  const selectedClaudeModelRef = useRef(selectedClaudeModel);
  const longContextEnabledRef = useRef(longContextEnabled);
  useEffect(() => { currentProviderRef.current = currentProvider; }, [currentProvider]);
  useEffect(() => { activeProviderConfigRef.current = activeProviderConfig; }, [activeProviderConfig]);
  useEffect(() => { selectedClaudeModelRef.current = selectedClaudeModel; }, [selectedClaudeModel]);
  useEffect(() => { longContextEnabledRef.current = longContextEnabled; }, [longContextEnabled]);

  // Select the displayed model based on the current provider
  const selectedModel = currentProvider === 'codex' ? selectedCodexModel : selectedClaudeModel;

  // Determine whether the SDK for the current provider is installed
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
  }, [sdkStatusLoaded, currentProvider, sdkStatus]);

  const syncActiveProviderModelMapping = useCallback((provider?: ProviderConfig | null) => {
    if (!provider || !provider.settingsConfig || !provider.settingsConfig.env) {
      writeClaudeModelMapping({});
      return;
    }
    const env = provider.settingsConfig.env as Record<string, any>;
    const mapping = {
      main: env.ANTHROPIC_MODEL ?? '',
      haiku: env.ANTHROPIC_SMALL_FAST_MODEL ?? env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
    };
    writeClaudeModelMapping(mapping);
  }, []);

  // Load model selection state from LocalStorage and sync to backend
  useEffect(() => {
    try {
      const saved = localStorage.getItem('model-selection-state');
      let restoredProvider = 'claude';
      let restoredClaudeModel = CLAUDE_MODELS[0].id;
      let restoredCodexModel = CODEX_MODELS[0].id;
      let restoredClaudePermissionMode: PermissionMode = 'bypassPermissions';
      let restoredCodexPermissionMode: PermissionMode = 'default';
      let initialPermissionMode: PermissionMode = 'bypassPermissions';
      let restoredLongContextEnabled = true;  // Default enabled

      if (saved) {
        const state = JSON.parse(saved);

        if (['claude', 'codex'].includes(state.provider)) {
          restoredProvider = state.provider;
          setCurrentProvider(state.provider);
        }

        if (isValidPermissionMode(state.claudePermissionMode)) {
          restoredClaudePermissionMode = state.claudePermissionMode;
        }
        if (isValidPermissionMode(state.codexPermissionMode)) {
          restoredCodexPermissionMode = state.codexPermissionMode === 'plan'
            ? 'default'
            : state.codexPermissionMode;
        }

        // Load long context setting (default true if not present)
        if (typeof state.longContextEnabled === 'boolean') {
          restoredLongContextEnabled = state.longContextEnabled;
          setLongContextEnabled(state.longContextEnabled);
        }

        const savedClaudeCustomModels = getCustomModels('claude-custom-models');
        // Strip [1m] suffix for internal state
        const strippedClaudeModel = strip1MContextSuffix(state.claudeModel);
        const normalizedClaudeModel = normalizeClaudeModelId(strippedClaudeModel);
        if (
          CLAUDE_MODELS.find(m => m.id === normalizedClaudeModel) ||
          savedClaudeCustomModels.find((m: { id: string }) => m.id === normalizedClaudeModel)
        ) {
          restoredClaudeModel = normalizedClaudeModel;
          setSelectedClaudeModel(normalizedClaudeModel);
        }

        const savedCodexCustomModels = getCustomModels('codex-custom-models');
        if (
          CODEX_MODELS.find(m => m.id === state.codexModel) ||
          savedCodexCustomModels.find((m: { id: string }) => m.id === state.codexModel)
        ) {
          restoredCodexModel = state.codexModel;
          setSelectedCodexModel(state.codexModel);
        }
      }

      initialPermissionMode = restoredProvider === 'codex'
        ? restoredCodexPermissionMode
        : restoredClaudePermissionMode;
      setClaudePermissionMode(restoredClaudePermissionMode);
      setCodexPermissionMode(restoredCodexPermissionMode);
      setPermissionMode(initialPermissionMode);

      let syncRetryCount = 0;
      const MAX_SYNC_RETRIES = 30;

      const syncToBackend = () => {
        if (window.sendToJava) {
          sendBridgeEvent('set_provider', restoredProvider);
          // For Claude, apply [1m] suffix if long context is enabled and model supports it
          const modelToSync = restoredProvider === 'codex'
            ? restoredCodexModel
            : apply1MContextSuffix(restoredClaudeModel, restoredLongContextEnabled);
          sendBridgeEvent('set_model', modelToSync);
          sendBridgeEvent('set_mode', initialPermissionMode);
        } else {
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          }
        }
      };
      setTimeout(syncToBackend, 200);
    } catch {
      // Failed to load model selection state
    }
  }, []);

  // Save model selection state to LocalStorage
  useEffect(() => {
    try {
      localStorage.setItem('model-selection-state', JSON.stringify({
        provider: currentProvider,
        claudeModel: selectedClaudeModel,
        codexModel: selectedCodexModel,
        claudePermissionMode,
        codexPermissionMode,
        longContextEnabled,
      }));
    } catch {
      // Failed to save model selection state
    }
  }, [currentProvider, selectedClaudeModel, selectedCodexModel, claudePermissionMode, codexPermissionMode, longContextEnabled]);

  // Load selected agent
  useEffect(() => {
    let retryCount = 0;
    const MAX_RETRIES = 10;
    let timeoutId: number | undefined;

    const loadSelectedAgent = () => {
      if (window.sendToJava) {
        sendBridgeEvent('get_selected_agent');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          timeoutId = window.setTimeout(loadSelectedAgent, 100);
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

  // Handler callbacks
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProviderRef.current === 'codex') {
      const codexMode: PermissionMode = mode === 'plan' ? 'default' : mode;
      setPermissionMode(codexMode);
      setCodexPermissionMode(codexMode);
      sendBridgeEvent('set_mode', codexMode);
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, []);

  const handleModelSelect = useCallback((modelId: string) => {
    if (currentProviderRef.current === 'claude') {
      const strippedModelId = strip1MContextSuffix(modelId);
      const normalizedModelId = normalizeClaudeModelId(strippedModelId);
      setSelectedClaudeModel(normalizedModelId);
      const modelToSync = apply1MContextSuffix(normalizedModelId, longContextEnabledRef.current);
      sendBridgeEvent('set_model', modelToSync);
    } else if (currentProviderRef.current === 'codex') {
      setSelectedCodexModel(modelId);
      sendBridgeEvent('set_model', modelId);
    }
  }, []);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);
    const modeToSet: PermissionMode = providerId === 'codex'
      ? (codexPermissionMode === 'plan' ? 'default' : codexPermissionMode)
      : claudePermissionMode;
    setPermissionMode(modeToSet);
    sendBridgeEvent('set_mode', modeToSet);

    const newModel = providerId === 'codex'
      ? selectedCodexModel
      : apply1MContextSuffix(selectedClaudeModel, longContextEnabledRef.current);
    sendBridgeEvent('set_model', newModel);
  }, [claudePermissionMode, codexPermissionMode, selectedCodexModel, selectedClaudeModel]);

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  }, []);

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
  }, []);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    const config = activeProviderConfigRef.current;
    const isSpecialProvider = isSpecialProviderId(config?.id || '');

    setClaudeSettingsAlwaysThinkingEnabled(enabled);

    if (!config || isSpecialProvider) {
      setActiveProviderConfig(prev => prev ? {
        ...prev,
        settingsConfig: {
          ...prev.settingsConfig,
          alwaysThinkingEnabled: enabled
        }
      } : prev);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled
      }
    } : null);

    const payload = JSON.stringify({
      id: config.id,
      updates: {
        settingsConfig: {
          ...(config.settingsConfig || {}),
          alwaysThinkingEnabled: enabled
        }
      }
    });
    sendBridgeEvent('update_provider', payload);
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [addToast, t]);

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

  const handleAutoOpenFileEnabledChange = useCallback((enabled: boolean) => {
    setAutoOpenFileEnabled(enabled);
    const payload = { autoOpenFileEnabled: enabled };
    sendBridgeEvent('set_auto_open_file_enabled', JSON.stringify(payload));
    addToast(enabled ? t('settings.basic.autoOpenFile.enabled') : t('settings.basic.autoOpenFile.disabled'), 'success');
  }, [t, addToast]);

  const handleLongContextChange = useCallback((enabled: boolean) => {
    setLongContextEnabled(enabled);
    if (currentProviderRef.current === 'claude') {
      const modelToSync = apply1MContextSuffix(selectedClaudeModelRef.current, enabled);
      sendBridgeEvent('set_model', modelToSync);
    }
  }, []);

  return {
    // States
    currentProvider, setCurrentProvider,
    selectedClaudeModel, setSelectedClaudeModel,
    selectedCodexModel, setSelectedCodexModel,
    claudePermissionMode, setClaudePermissionMode,
    codexPermissionMode, setCodexPermissionMode,
    permissionMode, setPermissionMode,
    reasoningEffort,
    usagePercentage, setUsagePercentage,
    usageUsedTokens, setUsageUsedTokens,
    usageMaxTokens, setUsageMaxTokens,
    setProviderConfigVersion,
    activeProviderConfig, setActiveProviderConfig,
    claudeSettingsAlwaysThinkingEnabled, setClaudeSettingsAlwaysThinkingEnabled,
    selectedAgent, setSelectedAgent,
    streamingEnabledSetting, setStreamingEnabledSetting,
    sendShortcut, setSendShortcut,
    autoOpenFileEnabled, setAutoOpenFileEnabled,
    longContextEnabled, setLongContextEnabled,
    sdkStatus, setSdkStatus,
    sdkStatusLoaded, setSdkStatusLoaded,
    // Computed
    selectedModel,
    currentSdkInstalled,
    // Refs
    currentProviderRef,
    activeProviderConfigRef,
    // Functions
    syncActiveProviderModelMapping,
    // Handlers
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleReasoningChange,
    handleAgentSelect,
    handleToggleThinking,
    handleStreamingEnabledChange,
    handleSendShortcutChange,
    handleAutoOpenFileEnabledChange,
    handleLongContextChange,
  };
}
