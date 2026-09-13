/**
 * Pure helpers for the model dropdown: provider grouping, pin persistence, and
 * list shaping. Used heavily by OpenCode (provider/model ids) but works for any
 * long model catalog that follows the same shape.
 */

import type { ModelInfo } from './types';

/** Show search once the list is long enough to scroll through. */
export const MODEL_SEARCH_THRESHOLD = 8;

/** Cap rendered rows so huge catalogs stay responsive; search finds the rest. */
export const MAX_VISIBLE_MODEL_OPTIONS = 100;

/** localStorage key: Record<providerId, modelId[]> */
export const PINNED_MODELS_STORAGE_KEY = 'pinned-models';

export const PINNED_GROUP_ID = '__pinned__';

export interface ModelGroup {
  id: string;
  label: string;
  models: ModelInfo[];
}

/**
 * Extract the vendor/group key from a model id.
 * OpenCode-style ids look like `opencode/big-pickle` → `opencode`.
 * Flat ids (Claude, Codex) return empty string (no group).
 */
export function getModelProviderGroup(modelId: string): string {
  const slash = modelId.indexOf('/');
  if (slash <= 0) return '';
  return modelId.slice(0, slash).trim();
}

export function shouldShowModelSearch(modelCount: number, searchQuery: string): boolean {
  return modelCount >= MODEL_SEARCH_THRESHOLD || searchQuery.trim().length > 0;
}

/**
 * Whether the list should render provider section headers.
 * Only when at least two distinct non-empty provider prefixes exist.
 */
export function shouldGroupModels(models: ModelInfo[]): boolean {
  const groups = new Set<string>();
  for (const model of models) {
    const group = getModelProviderGroup(model.id);
    if (group) groups.add(group);
    if (groups.size >= 2) return true;
  }
  return false;
}

export function readPinnedModelIds(providerId: string): string[] {
  if (!providerId) return [];
  try {
    const raw = localStorage.getItem(PINNED_MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const list = (parsed as Record<string, unknown>)[providerId];
    if (!Array.isArray(list)) return [];
    return list.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function writePinnedModelIds(providerId: string, modelIds: string[]): void {
  if (!providerId) return;
  try {
    const raw = localStorage.getItem(PINNED_MODELS_STORAGE_KEY);
    let store: Record<string, string[]> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          store = parsed as Record<string, string[]>;
        }
      } catch {
        store = {};
      }
    }
    const next = { ...store };
    if (modelIds.length === 0) {
      delete next[providerId];
    } else {
      next[providerId] = [...modelIds];
    }
    localStorage.setItem(PINNED_MODELS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // sandboxed / quota — ignore
  }
}

/** Toggle pin; returns the next pinned id list for this provider. */
export function togglePinnedModelId(providerId: string, modelId: string): string[] {
  const current = readPinnedModelIds(providerId);
  const exists = current.includes(modelId);
  const next = exists ? current.filter((id) => id !== modelId) : [...current, modelId];
  writePinnedModelIds(providerId, next);
  return next;
}

/**
 * Build dropdown sections:
 * 1. Pinned models (if any, preserving pin order)
 * 2. Remaining models — either one flat section or provider-prefix groups
 *
 * `visibleLimit` caps total models across all sections (pinned count first).
 */
export function buildModelDropdownSections(
  models: ModelInfo[],
  pinnedIds: string[],
  options?: { visibleLimit?: number },
): { sections: ModelGroup[]; hiddenCount: number } {
  const visibleLimit = options?.visibleLimit ?? MAX_VISIBLE_MODEL_OPTIONS;
  const byId = new Map(models.map((m) => [m.id, m]));
  const pinnedSet = new Set(pinnedIds);
  const pinnedModels: ModelInfo[] = [];
  for (const id of pinnedIds) {
    const model = byId.get(id);
    if (model) pinnedModels.push(model);
  }

  const unpinned = models.filter((m) => !pinnedSet.has(m.id));
  const useGroups = shouldGroupModels(unpinned);

  const sections: ModelGroup[] = [];
  let remaining = visibleLimit;

  if (pinnedModels.length > 0 && remaining > 0) {
    const slice = pinnedModels.slice(0, remaining);
    remaining -= slice.length;
    sections.push({
      id: PINNED_GROUP_ID,
      label: 'Pinned',
      models: slice,
    });
  }

  if (remaining <= 0) {
    const totalShown = sections.reduce((n, s) => n + s.models.length, 0);
    return { sections, hiddenCount: Math.max(0, models.length - totalShown) };
  }

  if (useGroups) {
    const order: string[] = [];
    const buckets = new Map<string, ModelInfo[]>();
    for (const model of unpinned) {
      const key = getModelProviderGroup(model.id) || 'other';
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(model);
    }
    for (const key of order) {
      if (remaining <= 0) break;
      const bucket = buckets.get(key) ?? [];
      const slice = bucket.slice(0, remaining);
      remaining -= slice.length;
      if (slice.length > 0) {
        sections.push({ id: key, label: key, models: slice });
      }
    }
  } else if (unpinned.length > 0) {
    const slice = unpinned.slice(0, remaining);
    remaining -= slice.length;
    sections.push({
      id: 'all',
      label: '',
      models: slice,
    });
  }

  const totalShown = sections.reduce((n, s) => n + s.models.length, 0);
  return { sections, hiddenCount: Math.max(0, models.length - totalShown) };
}
