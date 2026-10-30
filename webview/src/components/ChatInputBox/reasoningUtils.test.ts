import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeClaudeModelMapping } from '../../utils/claudeModelMapping';
import { claudeModelAllowsEffort, getAvailableReasoningLevels, isReasoningVisible, resolveCurrentReasoningLevel, useReasoningEffortGuard } from './reasoningUtils';

describe('cc-switch aggregated model effort', () => {
  beforeEach(() => localStorage.clear());
  it('uses the native Codex catalog for Ultra instead of the model family', () => {
    expect(getAvailableReasoningLevels('codex', 'gpt-6-astra', ['high', 'ultra']).map(level => level.id))
      .toEqual(['high', 'ultra']);
    expect(getAvailableReasoningLevels('codex', 'gpt-6-luna', ['low', 'high', 'max']).map(level => level.id))
      .toEqual(['low', 'high', 'max']);
    expect(getAvailableReasoningLevels('codex', 'gpt-6-astra').some(level => level.id === 'ultra')).toBe(false);
  });

  it.each(['claude', 'grok', 'dsh', 'kimi'])('never offers Codex Ultra to %s', provider => {
    expect(getAvailableReasoningLevels(provider, 'ccs-claude-route--anything', ['ultra']).some(level => level.id === 'ultra'))
      .toBe(false);
  });

  it('preserves restored Ultra until the catalog arrives, then corrects unsupported models', () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(({ efforts, pending }: { efforts?: string[]; pending: boolean }) =>
      useReasoningEffortGuard('ultra', onChange, 'gpt-6-luna', 'codex', efforts, pending),
    { initialProps: { pending: true } as { efforts?: string[]; pending: boolean } });
    expect(result.current.currentLevel?.id).toBe('ultra');
    expect(onChange).not.toHaveBeenCalled();
    rerender({ efforts: ['medium', 'high', 'max'], pending: false });
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('reconciles restored Ultra when the settled catalog has no custom model capabilities', () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(({ pending }) =>
      useReasoningEffortGuard('ultra', onChange, 'custom-model', 'codex', undefined, pending),
    { initialProps: { pending: true } });
    expect(result.current.currentLevel?.id).toBe('ultra');
    expect(onChange).not.toHaveBeenCalled();
    rerender({ pending: false });
    expect(result.current.currentLevel?.id).toBe('high');
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('keeps restored Ultra when the pending lookup confirms support', () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(({ efforts, pending }: { efforts?: string[]; pending: boolean }) =>
      useReasoningEffortGuard('ultra', onChange, 'native-model', 'codex', efforts, pending),
    { initialProps: { pending: true } as { efforts?: string[]; pending: boolean } });
    rerender({ efforts: ['high', 'ultra'], pending: false });
    expect(result.current.currentLevel?.id).toBe('ultra');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('corrects Ultra when switching to another provider', () => {
    const onChange = vi.fn();
    renderHook(() => useReasoningEffortGuard('ultra', onChange, 'claude-opus-5', 'claude'));
    expect(onChange).toHaveBeenCalledWith('high');
  });
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
