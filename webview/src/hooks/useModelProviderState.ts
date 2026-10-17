import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import {
  apply1MContextSuffix,
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
import { useZcodeProvider } from './providers/useZcodeProvider';
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
  resolveProviderModel,
  resolveProviderPermissionMode,
  selectedModelForProvider,
  withAlwaysThinkingEnabled,
  type CodexApprovalPreset,
  type CodexCollaborationMode,
  type CodexSandboxSelection,
  type CodexSandboxSource,
} from './modelProviderStateHelpers';

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
 * The ref is mirrored inside useEffect so no ref access happens during render.
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  // ── Cross-slice state owned by the orchestrator ──
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [codexCollaborationMode, setCodexCollaborationMode] = useState<CodexCollaborationMode>('default');
  const [codexApprovalPreset, setCodexApprovalPreset] = useState<CodexApprovalPreset>('request');
  const [codexSandboxSelection, setCodexSandboxSelection] = useState<CodexSandboxSelection>('workspace-write');
  const [codexSandboxSource, setCodexSandboxSource] = useState<CodexSandboxSource>('default');
  const [codexEffectiveSettings, setCodexEffectiveSettings] = useState<Record<string, unknown> | null>(null);
  const [codexSettingsPending, setCodexSettingsPending] = useState(false);

  // External-facing ref so window callbacks can read the latest provider
  // without re-binding. Mirrored in an effect (bridge callbacks fire async,
  // after commit) so render stays free of ref writes.
  const currentProviderRef = useRef(currentProvider);
  useEffect(() => {
    currentProviderRef.current = currentProvider;
  }, [currentProvider]);

  // Native settings acknowledgements only become effective after the app
  // server emits thread/settings/updated. Keep that boundary visible to the
  // UI so a mid-turn selection is presented as “next turn” until confirmed.
  useEffect(() => {
    const handleRuntimeEvent = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (currentProvider !== 'codex' || !detail || detail.kind !== 'thread/settings/updated'
        || (detail.rootThreadId && detail.threadId !== detail.rootThreadId)) return;
      const payload = detail.payload;
      setCodexEffectiveSettings(payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown> : null);
      const settings = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const collaboration = settings.collaborationMode as { mode?: string } | undefined;
      const sandbox = settings.sandboxPolicy as { type?: string } | string | undefined;
      const sandboxType = typeof sandbox === 'string' ? sandbox : sandbox?.type;
      const expectedSandbox = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[codexSandboxSelection];
      const expectedPolicy = codexApprovalPreset === 'sandboxed-auto' || codexApprovalPreset === 'full-access' ? 'never' : 'on-request';
      const expectedReviewer = codexApprovalPreset === 'request' ? 'user' : 'auto_review';
      const matches = collaboration?.mode === codexCollaborationMode && settings.approvalPolicy === expectedPolicy
        && settings.approvalsReviewer === expectedReviewer && (sandboxType === expectedSandbox || sandboxType === codexSandboxSelection);
      setCodexSettingsPending((pending) => pending && !matches);
    };
    window.addEventListener('codex-runtime-event', handleRuntimeEvent);
    return () => window.removeEventListener('codex-runtime-event', handleRuntimeEvent);
  }, [currentProvider, codexApprovalPreset, codexCollaborationMode, codexSandboxSelection]);

  // ── Provider-specific sub-hooks ──
  const claude = useClaudeProvider();
  const codex = useCodexProvider();
  const grok = useGrokProvider();
  const kimi = useKimiProvider();
  const miniMax = useMiniMaxProvider();
  const zcode = useZcodeProvider();
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
    selectedZcodeModel, setSelectedZcodeModel,
    zcodePermissionMode, setZcodePermissionMode,
  } = zcode;
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
    setSelectedZcodeModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedOmpModel,
    setSelectedDshModel,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setMiniMaxPermissionMode,
    setZcodePermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    setDshPermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    setDshPreset,
    setCodexCollaborationMode,
    setCodexApprovalPreset,
    setCodexSandboxSelection,
    setCodexSandboxSource,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedMiniMaxModel,
    selectedZcodeModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
    grokPermissionMode,
    kimiPermissionMode,
    miniMaxPermissionMode,
    zcodePermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
    dshPreset,
    codexCollaborationMode,
    codexApprovalPreset,
    codexSandboxSelection,
    codexSandboxSource,
  });

  // ── Computed values ──
  const selectedModel = selectedModelForProvider(currentProvider, {
    claude: selectedClaudeModel,
    codex: selectedCodexModel,
    grok: selectedGrokModel,
    kimi: selectedKimiModel,
    minimax: selectedMiniMaxModel,
    zcode: selectedZcodeModel,
    opencode: selectedOpenCodeModel,
    pi: selectedPiModel,
    omp: selectedOmpModel,
    dsh: selectedDshModel,
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
  // Whether the installed Claude SDK meets the minimum version required for
  // the selected feature tier. `undefined` means the backend has not reported it;
  // callers must only act on an explicit `false` to avoid false positives.
  // Codex no longer gates features on a TypeScript SDK version: its runtime is
  // the CLI itself and capability decisions come from the native runtime.
  const claudeSdkMeetsMinimum = sdkStatus?.['claude-sdk']?.meetsMinimumVersion;
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      // Codex exposes plan as a native collaboration mode while approval
      // policy remains an independent setting carried by the next turn.
      setPermissionMode(mode);
      setCodexPermissionMode(mode);
      const collaborationMode: CodexCollaborationMode = mode === 'plan' ? 'plan' : 'default';
      setCodexCollaborationMode(collaborationMode);
      sendBridgeEvent('set_codex_collaboration_mode', collaborationMode);
      const approvalPreset: CodexApprovalPreset = mode === 'plan'
          || (mode === 'default' && codexCollaborationMode === 'plan') ? codexApprovalPreset : mode === 'auto'
        ? 'auto'
        : mode === 'bypassPermissions' ? 'full-access' : 'request';
      setCodexApprovalPreset(approvalPreset);
      setCodexSettingsPending(true);
      sendBridgeEvent('set_codex_approval_preset', approvalPreset);
      if (mode === 'bypassPermissions') {
        setCodexSandboxSelection('danger-full-access');
        setCodexSandboxSource('user');
        sendBridgeEvent('set_codex_sandbox_selection', JSON.stringify({
          selection: 'danger-full-access',
          source: 'user',
        }));
      } else if (mode === 'auto' && codexSandboxSelection === 'danger-full-access') {
        // Auto review rejects a full-access sandbox; keeping the pair would
        // hard-block every Codex send until the sandbox is changed manually.
        setCodexSandboxSelection('workspace-write');
        setCodexSandboxSource('user');
        sendBridgeEvent('set_codex_sandbox_selection', JSON.stringify({
          selection: 'workspace-write',
          source: 'user',
        }));
      }
      sendBridgeEvent('set_mode', mode);
      return;
    }
    if (isCliOnlyProvider(currentProvider)) {
      applyCliModeSelect(currentProvider, mode, {
        setPermissionMode,
        setGrokPermissionMode,
        setKimiPermissionMode,
        setMiniMaxPermissionMode,
        setZcodePermissionMode,
        setOpenCodePermissionMode,
        setPiPermissionMode,
        setOmpPermissionMode,
        setDshPermissionMode,
        setSelectedOmpModel,
      });
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, [
    currentProvider,
    codexCollaborationMode,
    codexApprovalPreset,
    codexSandboxSelection,
    setCodexPermissionMode,
    setCodexCollaborationMode,
    setCodexApprovalPreset,
    setCodexSandboxSelection,
    setCodexSandboxSource,
    setClaudePermissionMode,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setMiniMaxPermissionMode,
    setZcodePermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    setSelectedOmpModel,
    setDshPermissionMode,
  ]);

  const handleModelSelect = useCallback((modelId: string) => {
    applyModelSelect(currentProvider, modelId, longContextEnabled, ompRoles, {
      setSelectedClaudeModel,
      setSelectedCodexModel,
      setSelectedGrokModel,
      setSelectedKimiModel,
      setSelectedMiniMaxModel,
      setSelectedZcodeModel,
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
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedMiniMaxModel,
    setSelectedZcodeModel,
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
      zcode: zcodePermissionMode,
      opencode: openCodePermissionMode,
      pi: piPermissionMode,
      omp: ompPermissionMode,
      dsh: dshPermissionMode,
    });
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
      zcode: selectedZcodeModel,
      opencode: selectedOpenCodeModel,
      pi: selectedPiModel,
      omp: selectedOmpModel,
      dsh: selectedDshModel,
    }, longContextEnabled);
    sendBridgeEvent('set_model', newModel);
  }, [
    claudePermissionMode,
    codexPermissionMode,
    grokPermissionMode,
    kimiPermissionMode,
    miniMaxPermissionMode,
    zcodePermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    selectedCodexModel,
    selectedClaudeModel,
    selectedGrokModel,
    selectedKimiModel,
    selectedMiniMaxModel,
    selectedZcodeModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
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
    ...zcode,
    ...openCode,
    ...pi,
    ...omp,
    ...dsh,
    ...usage,
    ...settings,
    sdkStatus,
    sdkStatusError: currentSdkStatusError,
    currentProvider, setCurrentProvider,
    permissionMode, setPermissionMode,
    codexCollaborationMode, setCodexCollaborationMode,
    codexApprovalPreset, setCodexApprovalPreset,
    codexSandboxSelection, setCodexSandboxSelection,
    codexSandboxSource, setCodexSandboxSource,
    codexEffectiveSettings,
    codexSettingsPending,
    selectedModel,
    currentSdkInstalled,
    claudeSdkMeetsMinimum,
    // The Codex runtime is the CLI itself; native auto capability is decided
    // by native constraints at send time, not by a TypeScript SDK version.
    codexNativeAutoReviewAvailable: true,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleDshPresetChange,
    handleLongContextChange,
    handleToggleThinking,
  };
}
