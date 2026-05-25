import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useSettingsBasicActions } from './useSettingsBasicActions';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';

describe('useSettingsBasicActions', () => {
  const defaultCommitAiConfig: CommitAiConfig = {
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
      'set_commit_ai_config:{"provider":"claude","models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.5"}}'
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
      'set_commit_ai_config:{"provider":"codex","models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.4"}}'
    );
  });

  it('updates prompt enhancer opencode provider and model', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.setPromptEnhancerConfig({
        provider: null,
        effectiveProvider: 'opencode',
        resolutionSource: 'auto',
        models: {
          claude: 'claude-sonnet-4-6',
          codex: 'gpt-5.5',
          opencode: 'opencode-default',
        },
        availability: {
          claude: false,
          codex: false,
          opencode: true,
        },
      });
    });

    act(() => {
      result.current.handlePromptEnhancerProviderChange('opencode');
    });

    act(() => {
      result.current.handlePromptEnhancerModelChange('opencode-default');
    });

    expect(result.current.promptEnhancerConfig.provider).toBe('opencode');
    expect(result.current.promptEnhancerConfig.models.opencode).toBe('opencode-default');
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_prompt_enhancer_config:{"provider":"opencode","models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.5","opencode":"opencode-default"}}'
    );
  });
});
