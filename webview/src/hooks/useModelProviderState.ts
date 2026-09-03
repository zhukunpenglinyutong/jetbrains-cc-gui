import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import {
  apply1MContextSuffix,
  GEMINI_DEFAULT_MODEL_ID,
  isValidDshPreset,
  isValidPermissionMode,
} from '../components/ChatInputBox/types';
import type { PermissionMode } from '../components/ChatInputBox/types';
import { isSpecialProviderId } from '../types/provider';
import { useClaudeProvider } from './providers/useClaudeProvider';
import { useCodexProvider } from './providers/useCodexProvider';
import { useGrokProvider } from './providers/useGrokProvider';
import { useKimiProvider } from './providers/useKimiProvider';
import { useMiniMaxProvider } from './providers/useMiniMaxProvider';
import { useOpenCodeProvider } from './providers/useOpenCodeProvider';
import { usePiProvider } from './providers/usePiProvider';
import { useOmpProvider } from './providers/useOmpProvider';
import { isCliOnlyProvider } from './providers/cliProviders';
import { useOmpRoles } from './providers/useCliModels';
import { useDshProvider } from './providers/useDshProvider';
import { useUsageTracking } from './providers/useUsageTracking';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';
import {
  applyCliModeSelect,
  applyModelSelect,
  buildThinkingUpdatePayload,
  resolveCodexModeSelection,
  resolveProviderModel,
  resolveProviderPermissionMode,
  selectedModelForProvider,
  withAlwaysThinkingEnabled,
} from './modelProviderStateHelpers';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
  /**
   * Fired when the active provider requires the backend conversation to be
   * discarded before the next send (Story 1.3, CAP-4). Today only the gemini
   * model change fires it: the CLI bakes the effort tier into the full model
   * slug, so a resumed conversation would feed prior context into a possibly
   * smaller-context model. The hook decides WHEN; App wires this to the
   * shared session transition (`forceCreateNewSession`: interrupt if
   * streaming → beginSessionTransition → create_new_session). Strictly
   * gemini-gated — every other provider keeps its behavior of continuing the
   * session across a model change.
   */
  onSessionResetRequest?: () => void;
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
 * The ref is mirrored inside useEffect so no ref access happens during render.
 */
export function useModelProviderState({ addToast, t, onSessionResetRequest }: UseModelProviderStateOptions) {
  // ── Cross-slice state owned by the orchestrator ──
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  // Gemini model slot: a full catalog slug where family+effort is ONE slug
  // ('auto' = let the CLI pick its own default). Any different slug —
  // including an effort-tier change — is a model change for the CAP-4
  // conversation reset below.
  const [selectedGeminiModel, setSelectedGeminiModel] = useState(GEMINI_DEFAULT_MODEL_ID);

  // Gemini mode slot: the CLI natively supports every shared posture including
  // plan and sandbox, so the choice is persisted un-coerced. Without a slot the
  // mode rides the shared claude one and a provider switch away and back
  // silently swaps the user's posture for claude's.
  const [geminiPermissionMode, setGeminiPermissionMode] = useState<PermissionMode>('default');

  // External-facing ref so window callbacks can read the latest provider
  // without re-binding. Mirrored in an effect (bridge callbacks fire async,
  // after commit) so render stays free of ref writes.
  const currentProviderRef = useRef(currentProvider);
  useEffect(() => {
    currentProviderRef.current = currentProvider;
  }, [currentProvider]);

  // ── Provider-specific sub-hooks ──
  const claude = useClaudeProvider();
  const codex = useCodexProvider();
  const grok = useGrokProvider();
  const kimi = useKimiProvider();
  const miniMax = useMiniMaxProvider();
  const openCode = useOpenCodeProvider();
  const pi = usePiProvider();
  const omp = useOmpProvider();
  // Dynamic omp model roles (listModels payload; static smol/slow/plan until
  // loaded) — drive mode⇔model unification for omp.
  const ompRoles = useOmpRoles();
  const dsh = useDshProvider();
  const { isSdkInstalled, isSdkStatusKnown, sdkStatus, ...usage } = useUsageTracking();
  const settings = useProviderSettings({ addToast, t });

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
    codexFastMode, setCodexFastMode,
  } = codex;
  const {
    selectedGrokModel, setSelectedGrokModel,
    grokPermissionMode, setGrokPermissionMode,
  } = grok;
  const {
    selectedKimiModel, setSelectedKimiModel,
    kimiPermissionMode, setKimiPermissionMode,
  } = kimi;
  const {
    selectedMiniMaxModel, setSelectedMiniMaxModel,
    miniMaxPermissionMode, setMiniMaxPermissionMode,
  } = miniMax;
  const {
    selectedOpenCodeModel, setSelectedOpenCodeModel,
    openCodePermissionMode, setOpenCodePermissionMode,
  } = openCode;
  const {
    selectedPiModel, setSelectedPiModel,
    piPermissionMode, setPiPermissionMode,
  } = pi;
  const {
    selectedOmpModel, setSelectedOmpModel,
    ompPermissionMode, setOmpPermissionMode,
  } = omp;
  const {
    selectedDshModel, setSelectedDshModel,
    dshPermissionMode, setDshPermissionMode,
    dshPreset, setDshPreset,
  } = dsh;

  // ── Persistence: load on mount + save on change ──
  useModelStatePersistence({
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedMiniMaxModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedOmpModel,
    setSelectedDshModel,
    setSelectedGeminiModel,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setMiniMaxPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    setDshPermissionMode,
    setGeminiPermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    setDshPreset,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedMiniMaxModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
    selectedGeminiModel,
    grokPermissionMode,
    kimiPermissionMode,
    miniMaxPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    geminiPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
    dshPreset,
  });

  // ── Computed values ──
  const selectedModel = selectedModelForProvider(currentProvider, {
    claude: selectedClaudeModel,
    codex: selectedCodexModel,
    grok: selectedGrokModel,
    kimi: selectedKimiModel,
    minimax: selectedMiniMaxModel,
    opencode: selectedOpenCodeModel,
    pi: selectedPiModel,
    omp: selectedOmpModel,
    dsh: selectedDshModel,
    gemini: selectedGeminiModel,
  });
  const currentSdkInstalled = useMemo(
    () => isSdkInstalled(currentProvider),
    [isSdkInstalled, currentProvider],
  );
  const currentSdkStatusError = useMemo(
    () => usage.sdkStatusError !== null && !isSdkStatusKnown(currentProvider)
      ? usage.sdkStatusError
      : null,
    [currentProvider, isSdkStatusKnown, usage.sdkStatusError],
  );
  // Whether the installed Claude/Codex SDK meets the minimum version required for
  // the selected feature tier. `undefined` means the backend has not reported it;
  // callers must only act on an explicit `false` to avoid false positives.
  const claudeSdkMeetsMinimum = sdkStatus?.['claude-sdk']?.meetsMinimumVersion;
  // Codex native auto review config is available in the verified @openai/codex-sdk 0.146.0 floor.
  const codexSdkMeetsMinimum = sdkStatus?.['codex-sdk']?.meetsMinimumVersion;
  const codexNativeAutoReviewAvailable = codexSdkMeetsMinimum === true;

  // A saved auto mode can outlive the SDK that supports it. Reset it before a
  // send can race the dependency-status response; otherwise the selected mode
  // would be sent to an SDK that cannot implement the native reviewer.
  useEffect(() => {
    if (codexSdkMeetsMinimum !== false || codexPermissionMode !== 'auto') {
      return;
    }
    setCodexPermissionMode('default');
    if (currentProvider === 'codex' && permissionMode === 'auto') {
      setPermissionMode('default');
      sendBridgeEvent('set_mode', 'default');
    }
  }, [codexPermissionMode, codexSdkMeetsMinimum, currentProvider, permissionMode, setCodexPermissionMode, setPermissionMode]);
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      const codexMode = resolveCodexModeSelection(mode, codexSdkMeetsMinimum);
      setPermissionMode(codexMode);
      setCodexPermissionMode(codexMode);
      sendBridgeEvent('set_mode', codexMode);
      return;
    }
    if (isCliOnlyProvider(currentProvider)) {
      applyCliModeSelect(currentProvider, mode, {
        setPermissionMode,
        setGrokPermissionMode,
        setKimiPermissionMode,
        setMiniMaxPermissionMode,
        setOpenCodePermissionMode,
        setPiPermissionMode,
        setOmpPermissionMode,
        setDshPermissionMode,
        setGeminiPermissionMode,
        setSelectedOmpModel,
      });
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, [
    currentProvider,
    codexSdkMeetsMinimum,
    setCodexPermissionMode,
    setClaudePermissionMode,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setMiniMaxPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    setSelectedOmpModel,
    setDshPermissionMode,
    setGeminiPermissionMode,
  ]);

  const handleModelSelect = useCallback((modelId: string) => {
    if (currentProvider === 'gemini') {
      // CAP-4 (Story 1.3): for gemini the effort tier is baked into the full
      // slug (family+effort = one slug), so ANY different slug — including an
      // effort-tier change — IS a model change. Resuming would replay the
      // prior conversation into a possibly smaller-context model (the
      // recorded CAP-4 failure mode), so an actual change discards the
      // backend conversation: the session reset clears the single session-id
      // slot, the next send carries no session id, and the CLI (which never
      // continues implicitly) starts a fresh conversation. A same-slug
      // reaffirmation is a no-op, matching Java's isActualModelSwitch.
      // Strictly gemini-gated: other providers keep their behavior.
      const isModelChange = modelId !== selectedGeminiModel;
      setSelectedGeminiModel(modelId);
      sendBridgeEvent('set_model', modelId);
      if (isModelChange) {
        onSessionResetRequest?.();
      }
      return;
    }
    applyModelSelect(currentProvider, modelId, longContextEnabled, ompRoles, {
      setSelectedClaudeModel,
      setSelectedCodexModel,
      setSelectedGrokModel,
      setSelectedKimiModel,
      setSelectedMiniMaxModel,
      setSelectedOpenCodeModel,
      setSelectedPiModel,
      setSelectedOmpModel,
      setSelectedDshModel,
      setOmpPermissionMode,
      setPermissionMode,
    });
  }, [
    currentProvider,
    longContextEnabled,
    ompRoles,
    selectedGeminiModel,
    onSessionResetRequest,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedMiniMaxModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedOmpModel,
    setOmpPermissionMode,
    setSelectedDshModel,
  ]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);

    const modeToSet = resolveProviderPermissionMode(providerId, {
      claude: claudePermissionMode,
      codex: codexPermissionMode,
      grok: grokPermissionMode,
      kimi: kimiPermissionMode,
      minimax: miniMaxPermissionMode,
      opencode: openCodePermissionMode,
      pi: piPermissionMode,
      omp: ompPermissionMode,
      dsh: dshPermissionMode,
      gemini: geminiPermissionMode,
    }, codexSdkMeetsMinimum);
    setPermissionMode(modeToSet);
    // Dynamic omp roles are not in Java's static mode whitelist — the
    // set_model event below carries the role; skip set_mode for them.
    if (providerId !== 'omp' || isValidPermissionMode(modeToSet)) {
      sendBridgeEvent('set_mode', modeToSet);
    }

    const newModel = resolveProviderModel(providerId, {
      claude: selectedClaudeModel,
      codex: selectedCodexModel,
      grok: selectedGrokModel,
      kimi: selectedKimiModel,
      minimax: selectedMiniMaxModel,
      opencode: selectedOpenCodeModel,
      pi: selectedPiModel,
      omp: selectedOmpModel,
      dsh: selectedDshModel,
      gemini: selectedGeminiModel,
    }, longContextEnabled);
    sendBridgeEvent('set_model', newModel);
  }, [
    claudePermissionMode,
    codexPermissionMode,
    codexSdkMeetsMinimum,
    grokPermissionMode,
    kimiPermissionMode,
    miniMaxPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    geminiPermissionMode,
    selectedCodexModel,
    selectedClaudeModel,
    selectedGrokModel,
    selectedKimiModel,
    selectedMiniMaxModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
    selectedGeminiModel,
    longContextEnabled,
  ]);

  const handleLongContextChange = useCallback((enabled: boolean) => {
    setLongContextEnabled(enabled);
    if (currentProvider === 'claude') {
      sendBridgeEvent('set_model', apply1MContextSuffix(selectedClaudeModel, enabled));
    }
  }, [currentProvider, selectedClaudeModel, setLongContextEnabled]);

  const handleDshPresetChange = useCallback((preset: string) => {
    if (!isValidDshPreset(preset)) return;
    setDshPreset(preset);
    if (currentProvider === 'dsh') {
      sendBridgeEvent('set_dsh_preset', preset);
    }
  }, [currentProvider, setDshPreset]);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    const config = settings.activeProviderConfig;
    const isSpecialProvider = isSpecialProviderId(config?.id || '');

    setClaudeSettingsAlwaysThinkingEnabled(enabled);

    if (!config || isSpecialProvider) {
      settings.setActiveProviderConfig(prev => withAlwaysThinkingEnabled(prev, enabled));
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    settings.setActiveProviderConfig(prev => withAlwaysThinkingEnabled(prev, enabled));

    sendBridgeEvent('update_provider', buildThinkingUpdatePayload(config, enabled));
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [settings, setClaudeSettingsAlwaysThinkingEnabled, addToast, t]);

  return {
    ...claude,
    ...codex,
    ...grok,
    ...kimi,
    ...miniMax,
    ...openCode,
    ...pi,
    ...omp,
    ...dsh,
    ...usage,
    ...settings,
    sdkStatus,
    sdkStatusError: currentSdkStatusError,
    currentProvider, setCurrentProvider,
    selectedGeminiModel, setSelectedGeminiModel,
    permissionMode, setPermissionMode,
    selectedModel,
    currentSdkInstalled,
    claudeSdkMeetsMinimum,
    codexNativeAutoReviewAvailable,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleDshPresetChange,
    handleLongContextChange,
    handleToggleThinking,
  };
}
