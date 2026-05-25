import { useCallback, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import {
  apply1MContextSuffix,
  normalizeClaudeModelId,
  OPENCODE_DEFAULT_MODEL_ID,
  strip1MContextSuffix,
} from '../components/ChatInputBox/types';
import type { PermissionMode } from '../components/ChatInputBox/types';
import { isSpecialProviderId } from '../types/provider';
import { useClaudeProvider } from './providers/useClaudeProvider';
import { useCodexProvider } from './providers/useCodexProvider';
import { useOpenCodeProvider } from './providers/useOpenCodeProvider';
import { useUsageTracking } from './providers/useUsageTracking';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * Orchestrates provider/model/permission state. Composes four single-purpose
 * sub-hooks (Claude / Codex / usage tracking / provider settings) plus a
 * persistence hook, then wires the cross-slice state (currentProvider +
 * permissionMode) and the cross-provider handlers (mode/model/provider switch,
 * long-context toggle, always-thinking toggle).
 *
 * The flat return shape is preserved as the public API: callers (App,
 * ChatScreen, AppDialogs, useMessageSender) destructure individual fields.
 *
 * `currentProviderRef` is exposed for window callbacks registered with stable
 * identity that must read the current provider when fired by the JCEF bridge.
 * The ref is updated via render-time assignment (no useEffect mirror).
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  // ── Cross-slice state owned by the orchestrator ──
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');

  // External-facing ref so window callbacks can read the latest provider
  // without re-binding. Render-time assignment avoids the useRef + useEffect
  // mirror anti-pattern (rule 5.15).
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;

  // ── Provider-specific sub-hooks ──
  const claude = useClaudeProvider();
  const codex = useCodexProvider();
  const opencode = useOpenCodeProvider();
  const { isSdkInstalled, ...usage } = useUsageTracking();
  const settings = useProviderSettings({ addToast, t });

  // Keep the settings hook's provider ref in sync with the current provider.
  settings.currentProviderRef.current = currentProvider;

  // Derive the selected agent for the current provider from the per-provider map.
  const selectedAgent = settings.agentsByProvider[currentProvider] ?? null;

  const {
    selectedClaudeModel, setSelectedClaudeModel,
    claudePermissionMode, setClaudePermissionMode,
    longContextEnabled, setLongContextEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
  } = claude;
  const {
    selectedCodexModel, setSelectedCodexModel,
    codexPermissionMode, setCodexPermissionMode,
    reasoningEffort, setReasoningEffort,
  } = codex;
  const {
    selectedOpenCodeModel, setSelectedOpenCodeModel,
    openCodePermissionMode, setOpenCodePermissionMode,
  } = opencode;

  // ── Persistence: load on mount + save on change ──
  useModelStatePersistence({
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedOpenCodeModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setOpenCodePermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setAgentsByProvider: settings.setAgentsByProvider,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    selectedOpenCodeModel,
    claudePermissionMode,
    codexPermissionMode,
    openCodePermissionMode,
    longContextEnabled,
    reasoningEffort,
    agentsByProvider: settings.agentsByProvider,
  });

  // ── Computed values ──
  const selectedModel = currentProvider === 'codex'
    ? selectedCodexModel
    : currentProvider === 'opencode'
      ? selectedOpenCodeModel
      : selectedClaudeModel;
  const currentSdkInstalled = useMemo(
    () => isSdkInstalled(currentProvider),
    [isSdkInstalled, currentProvider],
  );

  // ── Cross-provider handlers ──
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      const codexMode: PermissionMode = mode === 'plan' ? 'default' : mode;
      setPermissionMode(codexMode);
      setCodexPermissionMode(codexMode);
      sendBridgeEvent('set_mode', codexMode);
      return;
    }
    if (currentProvider === 'opencode') {
      setPermissionMode(mode);
      setOpenCodePermissionMode(mode);
      sendBridgeEvent('set_mode', mode);
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, [currentProvider, setCodexPermissionMode, setClaudePermissionMode, setOpenCodePermissionMode]);

  const handleModelSelect = useCallback((modelId: string) => {
    if (currentProvider === 'claude') {
      const strippedModelId = strip1MContextSuffix(modelId);
      const normalizedModelId = normalizeClaudeModelId(strippedModelId);
      setSelectedClaudeModel(normalizedModelId);
      sendBridgeEvent('set_model', apply1MContextSuffix(normalizedModelId, longContextEnabled));
    } else if (currentProvider === 'codex') {
      setSelectedCodexModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'opencode') {
      setSelectedOpenCodeModel(modelId);
      sendBridgeEvent('set_model', modelId);
    }
  }, [currentProvider, longContextEnabled, setSelectedClaudeModel, setSelectedCodexModel, setSelectedOpenCodeModel]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);

    const modeToSet: PermissionMode = providerId === 'codex'
      ? (codexPermissionMode === 'plan' ? 'default' : codexPermissionMode)
      : providerId === 'opencode'
        ? openCodePermissionMode
        : claudePermissionMode;
    setPermissionMode(modeToSet);
    sendBridgeEvent('set_mode', modeToSet);

    const newModel = providerId === 'codex'
      ? selectedCodexModel
      : providerId === 'opencode'
        ? selectedOpenCodeModel || OPENCODE_DEFAULT_MODEL_ID
        : apply1MContextSuffix(selectedClaudeModel, longContextEnabled);
    sendBridgeEvent('set_model', newModel);
  }, [
    claudePermissionMode,
    codexPermissionMode,
    openCodePermissionMode,
    selectedCodexModel,
    selectedOpenCodeModel,
    selectedClaudeModel,
    longContextEnabled,
  ]);

  const handleLongContextChange = useCallback((enabled: boolean) => {
    setLongContextEnabled(enabled);
    if (currentProvider === 'claude') {
      sendBridgeEvent('set_model', apply1MContextSuffix(selectedClaudeModel, enabled));
    }
  }, [currentProvider, selectedClaudeModel, setLongContextEnabled]);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    const config = settings.activeProviderConfig;
    const isSpecialProvider = isSpecialProviderId(config?.id || '');

    setClaudeSettingsAlwaysThinkingEnabled(enabled);

    if (!config || isSpecialProvider) {
      settings.setActiveProviderConfig(prev => prev ? {
        ...prev,
        settingsConfig: {
          ...prev.settingsConfig,
          alwaysThinkingEnabled: enabled,
        },
      } : prev);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    settings.setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled,
      },
    } : null);

    sendBridgeEvent('update_provider', JSON.stringify({
      id: config.id,
      updates: {
        settingsConfig: {
          ...(config.settingsConfig || {}),
          alwaysThinkingEnabled: enabled,
        },
      },
    }));
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [settings, setClaudeSettingsAlwaysThinkingEnabled, addToast, t]);

  return {
    ...claude,
    ...codex,
    ...usage,
    ...settings,
    currentProvider, setCurrentProvider,
    permissionMode, setPermissionMode,
    selectedModel,
    selectedAgent,
    currentSdkInstalled,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleLongContextChange,
    handleToggleThinking,
  };
}
