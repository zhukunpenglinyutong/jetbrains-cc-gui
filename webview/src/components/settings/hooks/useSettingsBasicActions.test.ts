import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useSettingsBasicActions } from './useSettingsBasicActions';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';
import { DEFAULT_AI_FEATURE_MODELS } from '../../../types/aiFeatureConfig';
import type { CodeFontConfig } from '../../../types/uiFontConfig';
import { BASH_GROUP_COLLAPSED_KEY } from '../../../utils/bashGroupCollapsePreference';
import { EDIT_GROUP_COLLAPSED_KEY } from '../../../utils/editGroupCollapsePreference';

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
    localStorage.removeItem(BASH_GROUP_COLLAPSED_KEY);
    localStorage.removeItem(EDIT_GROUP_COLLAPSED_KEY);
  });

  it('persists the batch collapse preference across settings remounts and syncs consumers', () => {
    const first = renderHook(() => useSettingsBasicActions({}));
    const second = renderHook(() => useSettingsBasicActions({}));
    expect(first.result.current.bashGroupCollapsedByDefault).toBe(false);

    act(() => first.result.current.handleBashGroupCollapsedByDefaultChange(true));
    expect(first.result.current.bashGroupCollapsedByDefault).toBe(true);
    expect(second.result.current.bashGroupCollapsedByDefault).toBe(true);
    expect(localStorage.getItem(BASH_GROUP_COLLAPSED_KEY)).toBe('true');

    first.unmount();
    const reopened = renderHook(() => useSettingsBasicActions({}));
    expect(reopened.result.current.bashGroupCollapsedByDefault).toBe(true);

    act(() => reopened.result.current.handleBashGroupCollapsedByDefaultChange(false));
    expect(reopened.result.current.bashGroupCollapsedByDefault).toBe(false);
    expect(second.result.current.bashGroupCollapsedByDefault).toBe(false);
    expect(localStorage.getItem(BASH_GROUP_COLLAPSED_KEY)).toBeNull();
  });

  it('persists the batch edit preference independently and syncs settings consumers', () => {
    const first = renderHook(() => useSettingsBasicActions({}));
    const second = renderHook(() => useSettingsBasicActions({}));
    expect(first.result.current.editGroupCollapsedByDefault).toBe(false);
    const diffExpandedBefore = first.result.current.diffExpandedByDefault;

    act(() => first.result.current.handleEditGroupCollapsedByDefaultChange(true));
    expect(second.result.current.editGroupCollapsedByDefault).toBe(true);
    expect(localStorage.getItem(EDIT_GROUP_COLLAPSED_KEY)).toBe('true');
    expect(first.result.current.bashGroupCollapsedByDefault).toBe(false);
    expect(first.result.current.diffExpandedByDefault).toBe(diffExpandedBefore);

    act(() => first.result.current.handleBashGroupCollapsedByDefaultChange(true));
    expect(first.result.current.editGroupCollapsedByDefault).toBe(true);

    first.unmount();
    const reopened = renderHook(() => useSettingsBasicActions({}));
    expect(reopened.result.current.editGroupCollapsedByDefault).toBe(true);

    act(() => reopened.result.current.handleEditGroupCollapsedByDefaultChange(false));
    expect(second.result.current.editGroupCollapsedByDefault).toBe(false);
    expect(reopened.result.current.bashGroupCollapsedByDefault).toBe(true);
    expect(localStorage.getItem(EDIT_GROUP_COLLAPSED_KEY)).toBeNull();
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
});
