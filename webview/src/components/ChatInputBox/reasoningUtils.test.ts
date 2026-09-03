import { describe, expect, it } from 'vitest';
import { getAvailableReasoningLevels, isReasoningVisible } from './reasoningUtils';

describe('isReasoningVisible', () => {
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
