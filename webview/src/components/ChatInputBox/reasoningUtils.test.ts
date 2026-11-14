import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeClaudeModelMapping } from '../../utils/claudeModelMapping';
import {
  claudeModelAllowsEffort,
  getAvailableReasoningLevels,
  isReasoningVisible,
  resolveCurrentReasoningLevel,
  resolveOmpReasoningLevel,
  useReasoningEffortGuard,
} from './reasoningUtils';
import { REASONING_LEVELS, type ReasoningEffort } from './types';

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
  const CLI_DEFAULT = ['low', 'medium', 'high', 'xhigh'];

  it('shows exactly the plugin levels the model lists, ignoring unknown ids', () => {
    expect(ids('anthropic/claude-opus-5-5')).toEqual(['low', 'high', 'max']);
  });

  it('resolves a role through its selector, stripping the :level suffix', () => {
    expect(ids('slow')).toEqual(['low', 'high', 'max']);
  });

  // `max` exists for few models, so it is only offered where omp lists it.
  it('offers what the other CLI providers offer when the model is not known', () => {
    expect(ids('auto')).toEqual(CLI_DEFAULT);
    expect(ids('ghost')).toEqual(CLI_DEFAULT);
    expect(ids('smol')).toEqual(CLI_DEFAULT);
    expect(ids('openai/gpt-x')).toEqual(CLI_DEFAULT);
    expect(ids('misc/odd')).toEqual(CLI_DEFAULT);
    expect(getAvailableReasoningLevels('omp', 'anthropic/claude-opus-5-5').map(level => level.id)).toEqual(CLI_DEFAULT);
  });

  it('leaves other providers unchanged', () => {
    expect(ids('anthropic/claude-opus-5-5', 'pi')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(ids('anthropic/claude-opus-5-5', 'grok')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  // The effort is shared by every provider: a model with [low, high, max] must
  // not turn an effort of xhigh into high for the provider the user returns to.
  it('shows the level omp will run with and leaves the stored effort alone', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useReasoningEffortGuard('xhigh', onChange, 'anthropic/claude-opus-5-5', 'omp', catalog));
    expect(result.current.currentLevel?.id).toBe('high');
    expect(onChange).not.toHaveBeenCalled();
  });

  // The outcomes are the ones `omp --thinking <level>` reports for such models.
  it.each<[ReasoningEffort[], ReasoningEffort, ReasoningEffort]>([
    [['low', 'high', 'max'], 'max', 'max'],
    [['low', 'high', 'max'], 'xhigh', 'high'],
    [['low', 'high', 'max'], 'medium', 'low'],
    [['low', 'medium', 'high'], 'max', 'high'],
    [['medium', 'high'], 'low', 'medium'],
    [['high', 'max'], 'low', 'high'],
  ])('a model offering %j runs an effort of %s as %s', (offered, effort, expected) => {
    const levels = REASONING_LEVELS.filter(level => offered.includes(level.id));
    expect(resolveOmpReasoningLevel(effort, levels)?.id).toBe(expected);
  });
});
