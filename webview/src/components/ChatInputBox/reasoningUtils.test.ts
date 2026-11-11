import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeClaudeModelMapping } from '../../utils/claudeModelMapping';
import { claudeModelAllowsEffort, getAvailableReasoningLevels, isReasoningVisible, resolveCurrentReasoningLevel, useReasoningEffortGuard } from './reasoningUtils';

describe('cc-switch aggregated model effort', () => {
  beforeEach(() => localStorage.clear());
  it('preserves all five effort levels for gateway models', () => {
    const id = 'ccs-claude-provider-a--glm-pro[1M]';
    expect(isReasoningVisible('claude', id)).toBe(true);
    expect(claudeModelAllowsEffort(id)).toBe(true);
    expect(getAvailableReasoningLevels('claude', id).map(level => level.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveCurrentReasoningLevel('max', getAvailableReasoningLevels('claude', id))?.id).toBe('max');
  });

  it('checks the upstream model rather than the provider key or context suffix', () => {
    expect(getAvailableReasoningLevels('claude', 'ccs-claude-provider-a--claude-opus-5[1M]').map(level => level.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getAvailableReasoningLevels('claude', 'ccs-claude-opus--glm-pro').map(level => level.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(isReasoningVisible('claude', 'claude-sonnet-5[1M]')).toBe(true);
  });

  it('keeps unsupported Claude models and malformed gateway routes excluded', () => {
    for (const id of ['claude-haiku-4-5', 'ccs-claude-provider-a--', 'ccs-claude---glm-pro']) {
      expect(isReasoningVisible('claude', id)).toBe(false);
      expect(claudeModelAllowsEffort(id)).toBe(false);
    }
  });

  it.each(['glm-pro', 'claude-sonnet-5'])('preserves xhigh and max for direct/route mapping %s', (model) => {
    writeClaudeModelMapping({ sonnet: model, sonnetName: 'Provider model' });
    expect(getAvailableReasoningLevels('claude', 'claude-sonnet-5').map(level => level.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveCurrentReasoningLevel('xhigh', getAvailableReasoningLevels('claude', 'claude-sonnet-5'))?.id).toBe('xhigh');
  });

  it('refreshes effort levels when the mapping changes but the selected alias stays the same', () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(() => useReasoningEffortGuard('xhigh', onChange, 'claude-sonnet-5', 'claude'));
    expect(onChange).toHaveBeenCalledWith('high');
    onChange.mockClear();
    writeClaudeModelMapping({ sonnet: 'claude-sonnet-5', sonnetName: 'Provider model' });
    rerender();
    expect(result.current.availableLevels.map(level => level.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('omp catalog-driven effort levels', () => {
  const catalog = {
    models: [
      { id: 'anthropic/claude-opus-5-5', label: 'Opus', supportedReasoningEfforts: ['minimal', 'low', 'high', 'max'] },
      { id: 'openai/gpt-x', label: 'GPT X' },
      { id: 'misc/odd', label: 'Odd', supportedReasoningEfforts: ['minimal'] },
    ],
    roles: [
      { id: 'slow', label: 'Slow', description: 'anthropic/claude-opus-5-5:xhigh' },
      { id: 'smol', label: 'Smol', description: 'openai/gpt-x' },
      { id: 'ghost', label: 'Ghost', description: 'nowhere/none:high' },
    ],
  };
  const ids = (model?: string, provider = 'omp') =>
    getAvailableReasoningLevels(provider, model, catalog).map(level => level.id);
  const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('shows exactly the plugin levels the model lists, ignoring unknown ids', () => {
    expect(ids('anthropic/claude-opus-5-5')).toEqual(['low', 'high', 'max']);
  });

  it('resolves a role through its selector, stripping the :level suffix', () => {
    expect(ids('slow')).toEqual(['low', 'high', 'max']);
  });

  it('shows all five levels when nothing is known', () => {
    expect(ids('auto')).toEqual(ALL);
    expect(ids('ghost')).toEqual(ALL);
    expect(ids('smol')).toEqual(ALL);
    expect(ids('openai/gpt-x')).toEqual(ALL);
    expect(ids('misc/odd')).toEqual(ALL);
    expect(getAvailableReasoningLevels('omp', 'anthropic/claude-opus-5-5').map(level => level.id)).toEqual(ALL);
  });

  it('leaves other providers unchanged', () => {
    expect(ids('anthropic/claude-opus-5-5', 'pi')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(ids('anthropic/claude-opus-5-5', 'grok')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('replaces an effort the new model does not offer, like other providers', () => {
    const onChange = vi.fn();
    renderHook(() => useReasoningEffortGuard('medium', onChange, 'anthropic/claude-opus-5-5', 'omp', catalog));
    expect(onChange).toHaveBeenCalledWith('high');
  });
});
