import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelInfo } from './types';
import {
  buildModelDropdownSections,
  getModelProviderGroup,
  PINNED_GROUP_ID,
  PINNED_MODELS_STORAGE_KEY,
  readPinnedModelIds,
  shouldGroupModels,
  shouldShowModelSearch,
  togglePinnedModelId,
  writePinnedModelIds,
} from './modelSelectUtils';

const models: ModelInfo[] = [
  { id: 'opencode/big-pickle', label: 'opencode/Big-Pickle' },
  { id: 'opencode/longcat-2.0-free', label: 'opencode/Longcat-2.0-Free' },
  { id: 'anthropic/claude-sonnet-4', label: 'anthropic/Claude-Sonnet-4' },
  { id: 'deepseek/deepseek-v4-flash-free', label: 'deepseek/Deepseek-V4-Flash-Free' },
  { id: 'opencode-default', label: 'OpenCode Default' },
];

describe('modelSelectUtils', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getModelProviderGroup', () => {
    it('returns provider prefix before slash', () => {
      expect(getModelProviderGroup('opencode/big-pickle')).toBe('opencode');
      expect(getModelProviderGroup('anthropic/claude-sonnet-4')).toBe('anthropic');
    });

    it('returns empty for flat ids', () => {
      expect(getModelProviderGroup('opencode-default')).toBe('');
      expect(getModelProviderGroup('gpt-5.5')).toBe('');
    });
  });

  describe('shouldGroupModels / shouldShowModelSearch', () => {
    it('groups only when two or more provider prefixes exist', () => {
      expect(shouldGroupModels(models)).toBe(true);
      expect(
        shouldGroupModels([
          { id: 'opencode/a', label: 'a' },
          { id: 'opencode/b', label: 'b' },
        ]),
      ).toBe(false);
      expect(shouldGroupModels([{ id: 'gpt-5.5', label: 'GPT-5.5' }])).toBe(false);
    });

    it('shows search when list is long enough or query is active', () => {
      expect(shouldShowModelSearch(7, '')).toBe(false);
      expect(shouldShowModelSearch(8, '')).toBe(true);
      expect(shouldShowModelSearch(3, 'op')).toBe(true);
    });
  });

  describe('pin persistence', () => {
    it('reads empty when nothing stored', () => {
      expect(readPinnedModelIds('opencode')).toEqual([]);
    });

    it('writes and toggles pins per provider', () => {
      writePinnedModelIds('opencode', ['opencode/big-pickle']);
      expect(readPinnedModelIds('opencode')).toEqual(['opencode/big-pickle']);
      expect(readPinnedModelIds('kimi')).toEqual([]);

      const afterAdd = togglePinnedModelId('opencode', 'deepseek/deepseek-v4-flash-free');
      expect(afterAdd).toEqual(['opencode/big-pickle', 'deepseek/deepseek-v4-flash-free']);

      const afterRemove = togglePinnedModelId('opencode', 'opencode/big-pickle');
      expect(afterRemove).toEqual(['deepseek/deepseek-v4-flash-free']);

      const raw = JSON.parse(localStorage.getItem(PINNED_MODELS_STORAGE_KEY) || '{}');
      expect(raw.opencode).toEqual(['deepseek/deepseek-v4-flash-free']);
    });

    it('removes provider key when last pin is cleared', () => {
      writePinnedModelIds('opencode', ['a']);
      togglePinnedModelId('opencode', 'a');
      const raw = JSON.parse(localStorage.getItem(PINNED_MODELS_STORAGE_KEY) || '{}');
      expect(raw.opencode).toBeUndefined();
    });
  });

  describe('buildModelDropdownSections', () => {
    it('puts pinned models first and groups the rest by provider', () => {
      const { sections, hiddenCount } = buildModelDropdownSections(models, [
        'deepseek/deepseek-v4-flash-free',
      ]);

      expect(hiddenCount).toBe(0);
      expect(sections[0]).toMatchObject({
        id: PINNED_GROUP_ID,
        models: [{ id: 'deepseek/deepseek-v4-flash-free' }],
      });

      const groupIds = sections.slice(1).map((s) => s.id);
      // provider-prefixed models keep their vendor groups; flat ids land in "other"
      expect(groupIds).toEqual(['opencode', 'anthropic', 'other']);
      expect(sections.find((s) => s.id === 'other')?.models.map((m) => m.id)).toEqual([
        'opencode-default',
      ]);
    });

    it('keeps a single flat section when grouping is not useful', () => {
      const flat: ModelInfo[] = [
        { id: 'gpt-5.5', label: 'GPT-5.5' },
        { id: 'gpt-5.4', label: 'GPT-5.4' },
      ];
      const { sections } = buildModelDropdownSections(flat, ['gpt-5.4']);
      expect(sections).toHaveLength(2);
      expect(sections[0].id).toBe(PINNED_GROUP_ID);
      expect(sections[1]).toMatchObject({ id: 'all', label: '', models: [{ id: 'gpt-5.5' }] });
    });

    it('respects visible limit and reports hidden count', () => {
      const many = Array.from({ length: 12 }, (_, i) => ({
        id: `opencode/m-${i}`,
        label: `M${i}`,
      }));
      const { sections, hiddenCount } = buildModelDropdownSections(many, [], {
        visibleLimit: 5,
      });
      const shown = sections.reduce((n, s) => n + s.models.length, 0);
      expect(shown).toBe(5);
      expect(hiddenCount).toBe(7);
    });

    it('does not duplicate a pinned model in its provider group', () => {
      const { sections } = buildModelDropdownSections(models, ['opencode/big-pickle']);
      const allIds = sections.flatMap((s) => s.models.map((m) => m.id));
      expect(allIds.filter((id) => id === 'opencode/big-pickle')).toHaveLength(1);
    });
  });
});

describe('buildModelDropdownSections with a groupOf override', () => {
  const models: ModelInfo[] = [
    { id: 'auto', label: 'Default (CLI)' },
    { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
    { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  ];
  // Family label per entry — the gemini dropdown's grouping callback shape.
  const groupOf = (m: ModelInfo) =>
    m.id === 'auto' ? 'Default (CLI)'
      : m.id.startsWith('gemini-3.7') ? 'Gemini 3.7 Flash'
        : m.label;

  it('groups by the supplied key even when id prefixes would not group', () => {
    const { sections } = buildModelDropdownSections(models, [], { groupOf });
    expect(sections.map((s) => s.label)).toEqual([
      'Default (CLI)',
      'Gemini 3.7 Flash',
      'Claude Opus 4.6 (Thinking)',
    ]);
    expect(sections[1].models.map((m) => m.id)).toEqual([
      'gemini-3.7-flash-high',
      'gemini-3.7-flash-low',
    ]);
  });

  it('falls back to the other bucket for empty keys and respects visibleLimit', () => {
    const { sections, hiddenCount } = buildModelDropdownSections(models, [], {
      groupOf: (m) => (m.id === 'claude-opus-4-6-thinking' ? '' : groupOf(m)),
      visibleLimit: 3,
    });
    // The limit is consumed by the first two buckets, so the empty-key row
    // never renders — the exhausted 'other' bucket is omitted and the row is
    // counted as hidden.
    expect(sections.map((s) => s.label)).toEqual(['Default (CLI)', 'Gemini 3.7 Flash']);
    expect(hiddenCount).toBe(1);
    const withRoom = buildModelDropdownSections(models, [], {
      groupOf: (m) => (m.id === 'claude-opus-4-6-thinking' ? '' : groupOf(m)),
    });
    expect(withRoom.sections.map((s) => s.label)).toEqual(['Default (CLI)', 'Gemini 3.7 Flash', 'other']);
    expect(withRoom.sections[2].models).toHaveLength(1);
    expect(withRoom.hiddenCount).toBe(0);
  });
});
