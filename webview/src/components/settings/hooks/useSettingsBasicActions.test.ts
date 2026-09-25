import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useSettingsBasicActions } from './useSettingsBasicActions';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';
import { DEFAULT_AI_FEATURE_MODELS } from '../../../types/aiFeatureConfig';
import type { CodeFontConfig } from '../../../types/uiFontConfig';

describe('useSettingsBasicActions', () => {
  const defaultCommitAiConfig: CommitAiConfig = {
    provider: null,
    effectiveProvider: 'codex',
    resolutionSource: 'auto',
    models: { ...DEFAULT_AI_FEATURE_MODELS },
    availability: {
      claude: true,
      codex: true,
      grok: false,
      kimi: false,
      opencode: false,
      pi: false,
      omp: false,
      minimax: false,
      zcode: false,
    },
  };

  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('updates commit AI provider without mutating prompt enhancer state', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.setCommitAiConfig(defaultCommitAiConfig);
    });

    const promptEnhancerBefore = result.current.promptEnhancerConfig;

    act(() => {
      result.current.handleCommitAiProviderChange('claude');
    });

    expect(result.current.commitAiConfig.provider).toBe('claude');
    expect(result.current.promptEnhancerConfig).toEqual(promptEnhancerBefore);
    expect(window.sendToJava).toHaveBeenCalledWith(
      `set_commit_ai_config:${JSON.stringify({
        provider: 'claude',
        models: defaultCommitAiConfig.models,
      })}`
    );
  });

  it('updates commit AI model without mutating prompt enhancer models', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.setCommitAiConfig({
        ...defaultCommitAiConfig,
        provider: 'codex',
        effectiveProvider: 'codex',
        resolutionSource: 'manual',
      });
    });

    const promptEnhancerBefore = result.current.promptEnhancerConfig;

    act(() => {
      result.current.handleCommitAiModelChange('gpt-5.4');
    });

    expect(result.current.commitAiConfig.models.codex).toBe('gpt-5.4');
    expect(result.current.promptEnhancerConfig).toEqual(promptEnhancerBefore);
    expect(window.sendToJava).toHaveBeenCalledWith(
      `set_commit_ai_config:${JSON.stringify({
        provider: 'codex',
        models: {
          ...defaultCommitAiConfig.models,
          codex: 'gpt-5.4',
        },
      })}`
    );
  });

  it('can select a beta CLI provider for commit AI settings', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.setCommitAiConfig({
        ...defaultCommitAiConfig,
        availability: { ...defaultCommitAiConfig.availability, grok: true },
      });
    });

    act(() => {
      result.current.handleCommitAiProviderChange('grok');
    });

    expect(result.current.commitAiConfig.provider).toBe('grok');
    expect(result.current.commitAiConfig.effectiveProvider).toBe('grok');
    expect(window.sendToJava).toHaveBeenCalledWith(
      expect.stringContaining('"provider":"grok"')
    );
  });

  it('prompt enhancer auto mode follows current chat provider when available', () => {
    const { result } = renderHook(() => useSettingsBasicActions({ currentProvider: 'grok' }));

    act(() => {
      result.current.setPromptEnhancerConfig({
        provider: null,
        effectiveProvider: 'codex',
        resolutionSource: 'auto',
        models: { ...DEFAULT_AI_FEATURE_MODELS },
        availability: {
          claude: true,
          codex: true,
          grok: true,
          kimi: false,
          opencode: false,
          pi: false,
          omp: false,
          minimax: false,
          zcode: false,
        },
      });
    });

    act(() => {
      result.current.handlePromptEnhancerResetToDefault();
    });

    expect(result.current.promptEnhancerConfig.provider).toBeNull();
    expect(result.current.promptEnhancerConfig.effectiveProvider).toBe('grok');
    expect(result.current.promptEnhancerConfig.resolutionSource).toBe('auto');
  });

  it('commit AI auto mode follows current chat provider when available', () => {
    const { result } = renderHook(() => useSettingsBasicActions({ currentProvider: 'grok' }));

    act(() => {
      result.current.setCommitAiConfig({
        provider: null,
        effectiveProvider: 'codex',
        resolutionSource: 'auto',
        models: { ...DEFAULT_AI_FEATURE_MODELS },
        availability: {
          claude: true,
          codex: true,
          grok: true,
          kimi: false,
          opencode: false,
          pi: false,
          omp: false,
          minimax: false,
          zcode: false,
        },
      });
    });

    act(() => {
      result.current.handleCommitAiResetToDefault();
    });

    expect(result.current.commitAiConfig.provider).toBeNull();
    expect(result.current.commitAiConfig.effectiveProvider).toBe('grok');
    expect(result.current.commitAiConfig.resolutionSource).toBe('auto');
  });

  it('prompt enhancer auto effectiveProvider updates when chat CLI changes', () => {
    const { result, rerender } = renderHook(
      ({ currentProvider }) => useSettingsBasicActions({ currentProvider }),
      { initialProps: { currentProvider: 'codex' } },
    );

    act(() => {
      result.current.setPromptEnhancerConfig({
        provider: null,
        effectiveProvider: 'codex',
        resolutionSource: 'auto',
        models: { ...DEFAULT_AI_FEATURE_MODELS },
        availability: {
          claude: true,
          codex: true,
          grok: true,
          kimi: false,
          opencode: false,
          pi: false,
          omp: false,
          minimax: false,
          zcode: false,
        },
      });
    });

    rerender({ currentProvider: 'grok' });

    expect(result.current.promptEnhancerConfig.provider).toBeNull();
    expect(result.current.promptEnhancerConfig.effectiveProvider).toBe('grok');
    expect(result.current.promptEnhancerConfig.resolutionSource).toBe('auto');
  });

  it('commit AI auto effectiveProvider updates when chat CLI changes', () => {
    const { result, rerender } = renderHook(
      ({ currentProvider }) => useSettingsBasicActions({ currentProvider }),
      { initialProps: { currentProvider: 'codex' } },
    );

    act(() => {
      result.current.setCommitAiConfig({
        provider: null,
        effectiveProvider: 'codex',
        resolutionSource: 'auto',
        models: { ...DEFAULT_AI_FEATURE_MODELS },
        availability: {
          claude: true,
          codex: true,
          grok: true,
          kimi: false,
          opencode: false,
          pi: false,
          omp: false,
          minimax: false,
          zcode: false,
        },
      });
    });

    rerender({ currentProvider: 'grok' });

    expect(result.current.commitAiConfig.provider).toBeNull();
    expect(result.current.commitAiConfig.effectiveProvider).toBe('grok');
    expect(result.current.commitAiConfig.resolutionSource).toBe('auto');
  });

  it('sends independent code font updates without mutating ui font state', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.handleCodeFontSelectionChange('followEditor');
    });

    expect(window.sendToJava).not.toHaveBeenCalledWith(
      'set_ui_font_config:{"mode":"customFile"}'
    );
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_code_font_config:{"mode":"followEditor"}'
    );
  });

  it('sends a code font customFile update when a saved path exists', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    const customCodeFontConfig: CodeFontConfig = {
      mode: 'customFile',
      effectiveMode: 'customFile',
      customFontPath: '/tmp/my-code-font.ttf',
      fontFamily: 'CC GUI Code Custom',
      fontSize: 13,
      lineSpacing: 1,
    };

    act(() => {
      result.current.setCodeFontConfig(customCodeFontConfig);
    });

    act(() => {
      result.current.handleCodeFontSelectionChange('customFile');
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_code_font_config:{"mode":"customFile","customFontPath":"/tmp/my-code-font.ttf"}'
    );
  });

  it('does not send anything when switching to customFile without a saved path (silent no-op)', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.handleCodeFontSelectionChange('customFile');
    });

    expect(window.sendToJava).not.toHaveBeenCalled();
  });

  describe('env file', () => {
    it('starts in the neutral unknown state, not a default "configured"', () => {
      const { result } = renderHook(() => useSettingsBasicActions({}));
      expect(result.current.envFileState).toBe('unknown');
      expect(result.current.envFileError).toBeNull();
    });

    it('sends a trimmed path', () => {
      const { result } = renderHook(() => useSettingsBasicActions({}));

      act(() => {
        result.current.handleEnvFileChange('  /projects/app/.env.local  ');
      });
      act(() => {
        result.current.handleSaveEnvFile();
      });

      expect(window.sendToJava).toHaveBeenCalledWith(
        'set_env_file:{"envFile":"/projects/app/.env.local"}'
      );
      expect(result.current.envFileError).toBeNull();
      expect(result.current.savingEnvFile).toBe(true);
    });

    it('sends an empty envFile as the explicit opt-out', () => {
      const { result } = renderHook(() => useSettingsBasicActions({}));

      act(() => {
        result.current.handleEnvFileChange('   ');
      });
      act(() => {
        result.current.handleSaveEnvFile();
      });

      expect(window.sendToJava).toHaveBeenCalledWith('set_env_file:{"envFile":""}');
    });

    it('refuses to send a traversing path and reports the reason', () => {
      const { result } = renderHook(() => useSettingsBasicActions({}));

      act(() => {
        result.current.handleEnvFileChange('../../etc/passwd');
      });
      act(() => {
        result.current.handleSaveEnvFile();
      });

      expect(window.sendToJava).not.toHaveBeenCalled();
      expect(result.current.envFileError).toBe('parentTraversal');
      expect(result.current.savingEnvFile).toBe(false);
    });

    it('refuses to send a path with a NUL byte', () => {
      const { result } = renderHook(() => useSettingsBasicActions({}));

      act(() => {
        result.current.handleEnvFileChange('/projects/app/.env\u0000.txt');
      });
      act(() => {
        result.current.handleSaveEnvFile();
      });

      expect(window.sendToJava).not.toHaveBeenCalled();
      expect(result.current.envFileError).toBe('invalidCharacters');
    });

    it('clears the error as soon as the user edits the field again', () => {
      const { result } = renderHook(() => useSettingsBasicActions({}));

      act(() => {
        result.current.handleEnvFileChange('..');
      });
      act(() => {
        result.current.handleSaveEnvFile();
      });
      expect(result.current.envFileError).toBe('parentTraversal');

      act(() => {
        result.current.handleEnvFileChange('/projects/app/.env');
      });

      expect(result.current.envFileError).toBeNull();
      expect(result.current.envFile).toBe('/projects/app/.env');
    });

    it('resets to auto-discovery with the dedicated reset payload', () => {
      const { result } = renderHook(() => useSettingsBasicActions({}));

      act(() => {
        result.current.handleResetEnvFile();
      });

      expect(window.sendToJava).toHaveBeenCalledWith('set_env_file:{"reset":true}');
      expect(result.current.savingEnvFile).toBe(true);
    });
  });
});
