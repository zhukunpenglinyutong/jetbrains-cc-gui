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
      'set_commit_ai_config:{"provider":"claude","models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.5"},"generationMode":"prompt","skillRef":"builtin:git-commit","language":"auto"}'
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
      'set_commit_ai_config:{"provider":"codex","models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.4"},"generationMode":"prompt","skillRef":"builtin:git-commit","language":"auto"}'
    );
  });

  it('updates commit generation mode and preserves the selected skill ref', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.setCommitAiConfig({
        ...defaultCommitAiConfig,
        generationMode: 'prompt',
        skillRef: 'builtin:git-commit',
      });
    });

    act(() => {
      result.current.handleCommitGenerationModeChange('skill');
    });

    expect(result.current.commitAiConfig.generationMode).toBe('skill');
    expect(result.current.commitAiConfig.skillRef).toBe('builtin:git-commit');
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_commit_ai_config:{"provider":null,"models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.5"},"generationMode":"skill","skillRef":"builtin:git-commit","language":"auto"}'
    );
  });

  it('updates commit skill selection and switches to skill mode', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.setCommitAiConfig(defaultCommitAiConfig);
    });

    act(() => {
      result.current.handleCommitSkillChange('local:/tmp/skills/git-commit');
    });

    expect(result.current.commitAiConfig.generationMode).toBe('skill');
    expect(result.current.commitAiConfig.skillRef).toBe('local:/tmp/skills/git-commit');
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_commit_ai_config:{"provider":null,"models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.5"},"generationMode":"skill","skillRef":"local:/tmp/skills/git-commit","language":"auto"}'
    );
  });

  it('updates commit language without changing the selected provider or skill', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.setCommitAiConfig({
        ...defaultCommitAiConfig,
        provider: 'codex',
        effectiveProvider: 'codex',
        resolutionSource: 'manual',
        generationMode: 'skill',
        skillRef: 'builtin:git-commit',
        language: 'auto',
      });
    });

    act(() => {
      result.current.handleCommitLanguageChange('ja');
    });

    expect(result.current.commitAiConfig.language).toBe('ja');
    expect(result.current.commitAiConfig.provider).toBe('codex');
    expect(result.current.commitAiConfig.skillRef).toBe('builtin:git-commit');
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_commit_ai_config:{"provider":"codex","models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.5"},"generationMode":"skill","skillRef":"builtin:git-commit","language":"ja"}'
    );
  });
});
