import { describe, expect, it } from 'vitest';
import { buildCodexModelList } from './codexModelList';
import { CODEX_MODELS } from './types';
import type { ModelInfo } from './types';

const catalog: ModelInfo[] = [
  { id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' },
];

describe('buildCodexModelList', () => {
  it('orders custom models first, then catalog, then built-ins', () => {
    const customs: ModelInfo[] = [{ id: 'my-model', label: 'My Model' }];
    expect(
      buildCodexModelList(catalog, customs, CODEX_MODELS).map((m) => m.id),
    ).toEqual(['my-model', 'kimi-k3', ...CODEX_MODELS.map((m) => m.id)]);
  });

  it('dedupes catalog entries that collide with customs (custom wins)', () => {
    const customs: ModelInfo[] = [{ id: 'kimi-k3', label: 'Custom Label' }];
    const merged = buildCodexModelList(catalog, customs, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe('Custom Label');
  });

  it('dedupes built-ins that collide with catalog (catalog wins)', () => {
    const catalogWithBuiltin: ModelInfo[] = [
      { id: 'gpt-5.5', label: 'gpt-5.5 (from config)' },
    ];
    const merged = buildCodexModelList(catalogWithBuiltin, [], CODEX_MODELS);
    expect(merged.map((m) => m.id)).toEqual([
      'gpt-5.5',
      ...CODEX_MODELS.map((m) => m.id).filter((id) => id !== 'gpt-5.5'),
    ]);
    expect(merged[0].label).toBe('gpt-5.5 (from config)');
  });

  it('keeps the catalog order (config default pinned first by the backend)', () => {
    const multi: ModelInfo[] = [
      { id: 'kimi-k3', label: 'kimi-k3' },
      { id: 'other-model', label: 'Other' },
    ];
    expect(buildCodexModelList(multi, [], []).map((m) => m.id)).toEqual([
      'kimi-k3',
      'other-model',
    ]);
  });

  it('returns customs + built-ins when the catalog is empty', () => {
    const customs: ModelInfo[] = [{ id: 'my-model', label: 'My Model' }];
    expect(buildCodexModelList([], customs, CODEX_MODELS).map((m) => m.id)).toEqual([
      'my-model',
      ...CODEX_MODELS.map((m) => m.id),
    ]);
  });

  it('falls back to the static built-in list when catalog and customs are empty', () => {
    const merged = buildCodexModelList([], [], CODEX_MODELS);
    expect(merged.map((m) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
  });

  it('custom-provider single default still surfaces full built-in lineup', () => {
    // Backend rule: custom provider without catalog → only config default.
    const singleDefault: ModelInfo[] = [{ id: 'gpt-5.5', label: 'gpt-5.5' }];
    const customs: ModelInfo[] = [{ id: 'relay-model', label: 'Relay' }];
    expect(
      buildCodexModelList(singleDefault, customs, CODEX_MODELS).map((m) => m.id),
    ).toEqual([
      'relay-model',
      'gpt-5.5',
      ...CODEX_MODELS.map((m) => m.id).filter((id) => id !== 'gpt-5.5'),
    ]);
  });
});
