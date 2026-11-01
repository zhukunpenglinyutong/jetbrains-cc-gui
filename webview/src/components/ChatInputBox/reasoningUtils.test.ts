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

describe('isReasoningVisible', () => {
  beforeEach(() => localStorage.clear());

  it('hides the generic effort row for gemini — tiers live inside the model slugs', () => {
    expect(isReasoningVisible('gemini', 'gemini-3.7-flash-high')).toBe(false);
    expect(isReasoningVisible('gemini', 'auto')).toBe(false);
    expect(isReasoningVisible('gemini', undefined)).toBe(false);
  });

  it('keeps the existing per-provider contract', () => {
    expect(isReasoningVisible('claude', 'claude-opus-4-8')).toBe(true);
    expect(isReasoningVisible('claude', 'claude-haiku-4-5')).toBe(false);
    expect(isReasoningVisible('claude', undefined)).toBe(true);
    expect(isReasoningVisible('codex', 'gpt-5.3-codex')).toBe(true);
    expect(isReasoningVisible('kimi', 'kimi-k2')).toBe(true);
  });
});

describe('getAvailableReasoningLevels', () => {
  it('never offers max for gemini alongside the hidden row', () => {
    const levels = getAvailableReasoningLevels('gemini', 'gemini-3.7-flash-high');
    expect(levels.some((level) => level.id === 'max')).toBe(false);
  });
});
