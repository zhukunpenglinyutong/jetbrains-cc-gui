import { describe, expect, it } from 'vitest';
import { resolveModelDisplayLabel, resolveMappedModelName, resolveModelIdForIcon } from './modelLabelUtils';

describe('Claude route and direct display names', () => {
  const t = (key: string) => key;
  it('uses configured display names for the selector and keeps the routing lookup unchanged', () => {
    const mapping = { sonnet: 'claude-sonnet-5[1M]', sonnetName: 'GLM Flash', fable: 'claude-fable-5', fableName: 'GLM Pro' };
    expect(resolveModelDisplayLabel({ id: 'claude-sonnet-5', label: 'Sonnet' }, { t, modelMapping: mapping })).toBe('GLM Flash');
    expect(resolveModelDisplayLabel({ id: 'claude-fable-5', label: 'Fable' }, { t, modelMapping: mapping })).toBe('GLM Pro');
    expect(resolveMappedModelName('sonnet', mapping)).toBe('claude-sonnet-5[1M]');
  });
  it('falls back to actual direct model ids when no display name is configured', () => {
    expect(resolveModelDisplayLabel({ id: 'claude-sonnet-5', label: 'Sonnet' }, { t, modelMapping: { sonnet: 'glm-flash' } })).toBe('glm-flash');
  });
});

import { resolveModelVendor } from '../../utils/modelIconMapping';

describe('aggregated route model icons', () => {
  it.each([
    ['openai', 'gpt-5.4', 'openai'], ['google', 'gemini-2.5-pro', 'gemini'],
    ['xai', 'grok-4', 'grok'], ['a', 'mistral-large', 'mistral'],
    ['a', 'llama-4', 'meta'], ['a', 'command-r', 'cohere'],
    ['deepseek', 'gpt-5.4', 'openai'], ['glm', 'gemini-2.5-pro', 'gemini'],
    ['openai', 'claude-sonnet-5', 'claude'], ['anthropic', 'qwen3', 'qwen'],
    ['a', 'deepseek-v3', 'deepseek'], ['a', 'glm-5', 'zhipu'],
    ['a', 'unknown-model', null],
  ])('uses upstream vendor for %s / %s', (provider, upstream, vendor) => {
    for (const suffix of ['', '[1M]', '[1m]']) {
      const id = 'ccs-claude-' + provider + '--' + upstream + suffix;
      const resolved = resolveModelIdForIcon(id, { main: 'wrong', sonnetName: 'wrong' });
      expect(resolved).toBe(upstream);
      expect(resolveModelVendor(resolved)).toBe(vendor);
    }
  });
  it.each(['ccs-claude-a--', 'ccs-claude---gpt-5', 'gpt-5.4', 'custom'])('preserves non-route or malformed id %s', id => {
    expect(resolveModelIdForIcon(id, {})).toBe(id);
  });
  it('uses mapped model ids, never display names, for direct provider icons', () => {
    const id = resolveModelIdForIcon('claude-sonnet-5', { sonnet: 'gpt-5.4', sonnetName: 'Claude Pro' });
    expect(resolveModelVendor(id)).toBe('openai');
  });
});
