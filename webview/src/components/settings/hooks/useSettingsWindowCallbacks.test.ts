import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsWindowCallbacks, type SettingsWindowCallbacksDeps } from './useSettingsWindowCallbacks';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';
import type { PromptEnhancerConfig } from '../../../types/promptEnhancer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('useSettingsWindowCallbacks', () => {
  const createDeps = (): SettingsWindowCallbacksDeps => ({
    setNodePath: vi.fn(),
    setNodeVersion: vi.fn(),
    setMinNodeVersion: vi.fn(),
    setSavingNodePath: vi.fn(),
    setWorkingDirectory: vi.fn(),
    setSavingWorkingDirectory: vi.fn(),
    setCommitPrompt: vi.fn(),
    setSavingCommitPrompt: vi.fn(),
    setCommitAiConfig: vi.fn(),
    setPromptEnhancerConfig: vi.fn(),
    setEditorFontConfig: vi.fn(),
    setUiFontConfig: vi.fn(),
    setIdeTheme: vi.fn(),
    setLocalStreamingEnabled: vi.fn(),
    setCodexSandboxMode: vi.fn(),
    setLocalSendShortcut: vi.fn(),
    setLoading: vi.fn(),
    setCodexLoading: vi.fn(),
    setCodexConfigLoading: vi.fn(),
    setSoundNotificationEnabled: vi.fn(),
    setSoundOnlyWhenUnfocused: vi.fn(),
    setSelectedSound: vi.fn(),
    setCustomSoundPath: vi.fn(),
    updateProviders: vi.fn(),
    updateActiveProvider: vi.fn(),
    loadProviders: vi.fn(),
    loadCodexProviders: vi.fn(),
    loadAgents: vi.fn(),
    updateAgents: vi.fn(),
    handleAgentOperationResult: vi.fn(),
    handleAgentImportPreviewResult: vi.fn(),
    handleAgentImportResult: vi.fn(),
    updateCodexProviders: vi.fn(),
    updateActiveCodexProvider: vi.fn(),
    updateCurrentCodexConfig: vi.fn(),
    cleanupAgentsTimeout: vi.fn(),
    showAlert: vi.fn(),
    addToast: vi.fn(),
  });

  beforeEach(() => {
    window.sendToJava = vi.fn();
    window.applyUiFontConfig = vi.fn();
  });

  it('does not auto-request current Claude config on mount', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    expect(deps.loadProviders).toHaveBeenCalledTimes(1);
    expect(deps.loadCodexProviders).toHaveBeenCalledTimes(1);
    expect(deps.loadAgents).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).not.toHaveBeenCalledWith('get_current_claude_config:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_node_path:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_working_directory:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_editor_font_config:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_streaming_enabled:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_codex_sandbox_mode:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_commit_prompt:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_commit_ai_config:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_prompt_enhancer_config:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_sound_notification_config:');
    expect(window.sendToJava).toHaveBeenCalledWith('get_ui_font_config:');
  });

  it('registers prompt enhancer callback and updates state from backend payload', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    const payload: PromptEnhancerConfig = {
      provider: null,
      effectiveProvider: 'codex',
      resolutionSource: 'auto',
      models: {
        claude: 'claude-sonnet-4-6',
        codex: 'gpt-5.5',
      },
      availability: {
        claude: true,
        codex: true,
      },
    };

    window.updatePromptEnhancerConfig?.(JSON.stringify(payload));

    expect(deps.setPromptEnhancerConfig).toHaveBeenCalledWith(payload);
  });

  it('registers commit AI callback and updates only commit AI state from backend payload', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    const payload: CommitAiConfig = {
      provider: null,
      effectiveProvider: 'codex',
      resolutionSource: 'auto',
      models: {
        claude: 'claude-sonnet-4-6',
        codex: 'gpt-5.5',
      },
      availability: {
        claude: true,
        codex: true,
      },
    };

    window.updateCommitAiConfig?.(JSON.stringify(payload));

    expect(deps.setCommitAiConfig).toHaveBeenCalledWith(payload);
    expect(deps.setPromptEnhancerConfig).not.toHaveBeenCalled();
  });

  it('registers ui font callback and updates ui font state from backend payload', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    (window as any).onUiFontConfigReceived?.(JSON.stringify({
      mode: 'customFile',
      effectiveMode: 'customFile',
      customFontPath: '/tmp/MapleMono.ttf',
      fontFamily: 'Codemoss UI Custom',
      fontSize: 14,
      lineSpacing: 1.35,
    }));

    expect((deps as any).setUiFontConfig).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'customFile',
      customFontPath: '/tmp/MapleMono.ttf',
      fontFamily: 'Codemoss UI Custom',
    }));
  });

  it('applies ui font immediately when backend pushes updated config', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    const payload = {
      mode: 'customFile',
      effectiveMode: 'customFile',
      customFontPath: '/tmp/MapleMono.ttf',
      fontFamily: 'Codemoss UI Custom',
      fontSize: 14,
      lineSpacing: 1.35,
      fontBase64: 'AAECA',
      fontFormat: 'truetype',
    };

    (window as any).onUiFontConfigReceived?.(JSON.stringify(payload));

    expect(window.applyUiFontConfig).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'customFile',
      customFontPath: '/tmp/MapleMono.ttf',
      fontBase64: 'AAECA',
      fontFormat: 'truetype',
    }));
  });
});
