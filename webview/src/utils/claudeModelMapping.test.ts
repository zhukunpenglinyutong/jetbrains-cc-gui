import { describe, expect, it, beforeEach, vi } from 'vitest';
import { STORAGE_KEYS } from '../types/provider';
import { applyClaudeModelMapping, parseClaudeModelMappingEnv, resolveClaudeModelMappingLabel, writeClaudeModelMapping } from './claudeModelMapping';

describe('writeClaudeModelMapping', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('extracts all four model roles and display names without credentials', () => {
    expect(parseClaudeModelMappingEnv({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: ' Flash ',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Pro',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5', ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Fable Pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5', ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'Fast',
      ANTHROPIC_AUTH_TOKEN: 'secret', OTHER: 'ignored',
    })).toEqual({ sonnet: 'claude-sonnet-5', sonnetName: 'Flash', opus: 'claude-opus-5', opusName: 'Pro', fable: 'claude-fable-5', fableName: 'Fable Pro', haiku: 'claude-haiku-4-5', haikuName: 'Fast' });
    expect(parseClaudeModelMappingEnv(null)).toEqual({});
  });

  it('prefers the display name while preserving the selectable model id', () => {
    expect(applyClaudeModelMapping({ id: 'claude-sonnet-5', label: 'Sonnet 5' }, { sonnet: 'claude-sonnet-5[1M]', sonnetName: 'GLM Flash' }))
      .toEqual({ id: 'claude-sonnet-5', label: 'GLM Flash' });
    expect(applyClaudeModelMapping({ id: 'claude-fable-5', label: 'Fable 5' }, { fable: 'glm-pro', fableName: 'Pro' }).label).toBe('Pro');
    expect(resolveClaudeModelMappingLabel('sonnet', { sonnet: 'glm-flash', sonnetName: ' ' })).toBe('glm-flash');
    expect(resolveClaudeModelMappingLabel('opus', { main: 'glm-pro', opusName: 'Unused name' })).toBe('glm-pro');
  });

  it('写入映射后应派发同 tab 刷新事件', () => {
    const listener = vi.fn();
    window.addEventListener('localStorageChange', listener as EventListener);

    writeClaudeModelMapping({ sonnet: 'glm-5' });

    expect(localStorage.getItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING)).toBe(
      JSON.stringify({ sonnet: 'glm-5' }),
    );
    expect(listener).toHaveBeenCalledTimes(1);

    const event = listener.mock.calls[0]?.[0] as CustomEvent<{ key: string }>;
    expect(event.detail.key).toBe(STORAGE_KEYS.CLAUDE_MODEL_MAPPING);

    window.removeEventListener('localStorageChange', listener as EventListener);
  });
});

describe('main and role label precedence', () => {
  it.each(['haiku', 'sonnet', 'opus', 'fable'])('keeps %s display names scoped to populated role slots', role => {
    expect(resolveClaudeModelMappingLabel(role, { main: ' global ', [role + 'Name']: 'Alias' })).toBe('global');
    expect(resolveClaudeModelMappingLabel(role, { main: 'global', [role]: ' ', [role + 'Name']: 'Alias' })).toBe('global');
    expect(resolveClaudeModelMappingLabel(role, { [role + 'Name']: 'Alias' })).toBeUndefined();
    expect(resolveClaudeModelMappingLabel(role, { main: 'global', [role]: ' target ', [role + 'Name']: ' Alias ' })).toBe('Alias');
    expect(resolveClaudeModelMappingLabel(role, { main: 'global', [role]: ' target ', [role + 'Name']: ' ' })).toBe('target');
  });
  it('falls back to main for an unknown role and preserves the original entry without a mapping', () => {
    expect(resolveClaudeModelMappingLabel(undefined, { main: ' global ', opusName: 'Alias' })).toBe('global');
    expect(resolveClaudeModelMappingLabel('sonnet', { main: ' ' })).toBeUndefined();
    const original = { id: 'claude-sonnet-5', label: 'Sonnet' };
    expect(applyClaudeModelMapping(original, { sonnetName: 'orphan' })).toEqual(original);
    expect(applyClaudeModelMapping(original, { main: 'global', sonnetName: 'orphan' })).toEqual({ ...original, label: 'global' });
  });
});
