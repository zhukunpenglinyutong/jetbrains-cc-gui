import { beforeEach, describe, expect, it } from 'vitest';
import { readCustomClaudeModelIds, readCustomClaudeModels } from './customClaudeModels';

describe('customClaudeModels', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty list when nothing is stored', () => {
    expect(readCustomClaudeModels()).toEqual([]);
    expect(readCustomClaudeModelIds().size).toBe(0);
  });

  it('tags every stored entry as custom and falls back to the id as label', () => {
    localStorage.setItem('claude-custom-models', JSON.stringify([
      { id: 'claude-opus-4-6', label: 'Opus 4.6', description: 'mine' },
      { id: 'claude-opus-4-8' },
    ]));

    expect(readCustomClaudeModels()).toEqual([
      { id: 'claude-opus-4-6', label: 'Opus 4.6', description: 'mine', isCustom: true },
      { id: 'claude-opus-4-8', label: 'claude-opus-4-8', description: undefined, isCustom: true },
    ]);
    expect([...readCustomClaudeModelIds()]).toEqual(['claude-opus-4-6', 'claude-opus-4-8']);
  });

  it('drops malformed entries and survives invalid JSON', () => {
    localStorage.setItem('claude-custom-models', JSON.stringify([
      null, 'str', { id: '' }, { id: '  ' }, { label: 'no id' }, { id: 'ok' },
    ]));
    expect(readCustomClaudeModels().map(m => m.id)).toEqual(['ok']);

    localStorage.setItem('claude-custom-models', '{not json');
    expect(readCustomClaudeModels()).toEqual([]);

    localStorage.setItem('claude-custom-models', JSON.stringify({ id: 'not-an-array' }));
    expect(readCustomClaudeModels()).toEqual([]);
  });
});
