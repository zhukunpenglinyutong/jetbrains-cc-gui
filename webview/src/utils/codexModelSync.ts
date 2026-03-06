import { CODEX_MODELS } from '../components/ChatInputBox/types';
import type { CodexCustomModel } from '../types/provider';
import { STORAGE_KEYS, validateCodexCustomModels } from '../types/provider';

export interface SyncCodexModelsResult {
  ok: boolean;
  count: number;
}

export function getOfficialCodexCustomModels(): CodexCustomModel[] {
  return CODEX_MODELS.map((model) => ({
    id: model.id,
    label: model.label || model.id,
    description: model.description,
  }));
}

export function syncLatestCodexModels(): SyncCodexModelsResult {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ok: false, count: 0 };
  }

  const officialModels = getOfficialCodexCustomModels();
  const stored = window.localStorage.getItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS);
  const existing = stored ? validateCodexCustomModels(JSON.parse(stored)) : [];
  const knownIds = new Set(officialModels.map((model) => model.id));
  const merged = [...officialModels];

  for (const model of existing) {
    if (!knownIds.has(model.id)) {
      merged.push(model);
    }
  }

  window.localStorage.setItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS, JSON.stringify(merged));
  window.dispatchEvent(new CustomEvent('localStorageChange', {
    detail: { key: STORAGE_KEYS.CODEX_CUSTOM_MODELS },
  }));

  return { ok: true, count: officialModels.length };
}
