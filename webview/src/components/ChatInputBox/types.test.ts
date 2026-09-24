import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL_ID,
  isRetiredClaudeModelId,
  normalizeClaudeModelId,
} from './types';

describe('normalizeClaudeModelId', () => {
  it('falls back to the default model for empty input', () => {
    expect(normalizeClaudeModelId(null)).toBe(DEFAULT_CLAUDE_MODEL_ID);
    expect(normalizeClaudeModelId(undefined)).toBe(DEFAULT_CLAUDE_MODEL_ID);
    expect(normalizeClaudeModelId('')).toBe(DEFAULT_CLAUDE_MODEL_ID);
  });

  it('keeps the default model inside CLAUDE_MODELS', () => {
    // The fallback must always be selectable — deriving it from CLAUDE_MODELS[0]
    // (the newest tier) broke users whose API relay lacks that model.
    expect(CLAUDE_MODELS.some((m) => m.id === DEFAULT_CLAUDE_MODEL_ID)).toBe(true);
  });

  it('migrates retired Sonnet 4.6 to the current default', () => {
    // Saved by versions <= 0.4.7 where sonnet-4-6 was the default model.
    expect(normalizeClaudeModelId('claude-sonnet-4-6')).toBe('claude-sonnet-5');
  });

  it('migrates retired Sonnet 4.7 to the current default', () => {
    // Saved by versions <= 0.5.2 where sonnet-4-7 was the default model (#1678).
    expect(normalizeClaudeModelId('claude-sonnet-4-7')).toBe('claude-sonnet-5');
  });

  it('migrates retired Opus generations to Opus 5', () => {
    expect(normalizeClaudeModelId('claude-opus-4-8')).toBe('claude-opus-5');
  });

  it('migrates retired IDs carrying a [1m] suffix', () => {
    expect(normalizeClaudeModelId('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-5');
    expect(normalizeClaudeModelId('claude-sonnet-4-7[1m]')).toBe('claude-sonnet-5');
    expect(normalizeClaudeModelId('claude-opus-4-8[1m]')).toBe('claude-opus-5');
  });

  it('keeps claude-opus-4-6 untouched: still a live model, used as a custom model', () => {
    expect(normalizeClaudeModelId('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(normalizeClaudeModelId('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
  });

  it('leaves current models untouched', () => {
    for (const model of CLAUDE_MODELS) {
      expect(normalizeClaudeModelId(model.id)).toBe(model.id);
    }
  });

  it('leaves unknown custom model IDs untouched', () => {
    expect(normalizeClaudeModelId('qwen3.5-plus')).toBe('qwen3.5-plus');
  });

  it('never migrates an id the user added as a custom model, even a retired one', () => {
    const customIds = new Set(['claude-opus-4-8', 'claude-sonnet-4-7']);
    expect(normalizeClaudeModelId('claude-opus-4-8', customIds)).toBe('claude-opus-4-8');
    expect(normalizeClaudeModelId('claude-opus-4-8[1m]', customIds)).toBe('claude-opus-4-8');
    expect(normalizeClaudeModelId('claude-sonnet-4-7', customIds)).toBe('claude-sonnet-4-7');
    // Retired ids that are NOT custom still migrate.
    expect(normalizeClaudeModelId('claude-sonnet-4-6', customIds)).toBe('claude-sonnet-5');
    // An empty custom set behaves like the plain migration.
    expect(normalizeClaudeModelId('claude-opus-4-8', new Set())).toBe('claude-opus-5');
  });
});

describe('isRetiredClaudeModelId', () => {
  it('flags ids in the migration table, with or without the [1m] suffix', () => {
    expect(isRetiredClaudeModelId('claude-opus-4-8')).toBe(true);
    expect(isRetiredClaudeModelId('claude-opus-4-8[1m]')).toBe(true);
    expect(isRetiredClaudeModelId('claude-sonnet-4-6')).toBe(true);
  });

  it('does not flag live, custom, or empty ids', () => {
    expect(isRetiredClaudeModelId('claude-opus-4-6')).toBe(false);
    expect(isRetiredClaudeModelId('claude-opus-5')).toBe(false);
    expect(isRetiredClaudeModelId('qwen3.5-plus')).toBe(false);
    expect(isRetiredClaudeModelId('')).toBe(false);
    expect(isRetiredClaudeModelId(null)).toBe(false);
  });
});
