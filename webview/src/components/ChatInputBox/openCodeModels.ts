import { OPENCODE_DEFAULT_MODEL_ID, OPENCODE_MODELS } from './types';
import type { ModelInfo } from './types';

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeModel(raw: unknown): ModelInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const id = asNonEmptyString(candidate.id);
  if (!id) {
    return null;
  }

  const label = asNonEmptyString(candidate.label) ?? id;
  const description = asNonEmptyString(candidate.description);
  return description ? { id, label, description } : { id, label };
}

export function parseOpenCodeModelPayload(payload: string): { models: ModelInfo[], error?: string } {
  try {
    const parsed = JSON.parse(payload);
    if (parsed?.success === false && parsed?.error) {
      return { models: [], error: parsed.error };
    }
    const rawModels: unknown[] = Array.isArray(parsed?.models) ? parsed.models : [];
    const models = rawModels
      .map(normalizeModel)
      .filter((model: ModelInfo | null): model is ModelInfo => model !== null);
    
    if (models.length > 0 && !models.some(m => m.id === OPENCODE_DEFAULT_MODEL_ID)) {
      return { models: [OPENCODE_MODELS[0], ...models] };
    }
    return { models: models.length > 0 ? models : OPENCODE_MODELS };
  } catch (e: any) {
    return { models: [], error: e.message || 'Failed to parse opencode models' };
  }
}

export function ensureSelectedOpenCodeModel(
  models: ModelInfo[],
  selectedModel?: string
): ModelInfo[] {
  const baseModels = models.length > 0 ? models : OPENCODE_MODELS;
  const selectedId = asNonEmptyString(selectedModel);
  if (!selectedId || baseModels.some((model) => model.id === selectedId)) {
    return baseModels;
  }
  return baseModels;
}