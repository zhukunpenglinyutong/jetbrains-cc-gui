import { OPENCODE_DEFAULT_MODEL_ID, OPENCODE_MODELS } from './types';
import type { ModelInfo } from './types';

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeModelVariants(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const variants = raw
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean);
    return variants.length > 0 ? variants : undefined;
  }
  if (raw && typeof raw === 'object') {
    const variants = Object.keys(raw as Record<string, unknown>)
      .map((key) => key.trim())
      .filter(Boolean);
    return variants.length > 0 ? variants : undefined;
  }
  return undefined;
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
  const variants = normalizeModelVariants(candidate.variants);
  const base = description ? { id, label, description } : { id, label };
  return variants ? { ...base, variants } : base;
}

function formatOpenCodeDefaultDescription(defaultModel: string, defaultModelSource?: string): string {
  const sourceText = {
    config: 'from opencode config',
    'provider-default': 'provider default',
    'first-available': 'as first available model',
    'last-used': 'last used in this project',
  }[defaultModelSource ?? ''] || 'configured in opencode';
  return `Uses ${defaultModel} ${sourceText}.`;
}

function applyDefaultModelMetadata(
  models: ModelInfo[],
  defaultModel?: string,
  defaultModelSource?: string
): ModelInfo[] {
  if (!defaultModel) {
    return models;
  }

  return models.map((model) => {
    if (model.id !== OPENCODE_DEFAULT_MODEL_ID) {
      return model;
    }
    return {
      ...model,
      description: formatOpenCodeDefaultDescription(defaultModel, defaultModelSource),
    };
  });
}

export function parseOpenCodeModelPayload(payload: string): {
  models: ModelInfo[];
  defaultModel?: string;
  defaultModelSource?: string;
  error?: string;
} {
  try {
    const parsed = JSON.parse(payload);
    if (parsed?.success === false && parsed?.error) {
      return { models: [], error: parsed.error };
    }
    const defaultModel = asNonEmptyString(parsed?.defaultModel);
    const defaultModelSource = asNonEmptyString(parsed?.defaultModelSource);
    const rawModels: unknown[] = Array.isArray(parsed?.models) ? parsed.models : [];
    let models = rawModels
      .map(normalizeModel)
      .filter((model: ModelInfo | null): model is ModelInfo => model !== null);

    models = applyDefaultModelMetadata(models, defaultModel, defaultModelSource);

    if (models.length > 0 && !models.some(m => m.id === OPENCODE_DEFAULT_MODEL_ID)) {
      return { models: [OPENCODE_MODELS[0], ...models], defaultModel, defaultModelSource };
    }
    return {
      models: models.length > 0 ? models : OPENCODE_MODELS,
      defaultModel,
      defaultModelSource,
    };
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
  if (selectedId === OPENCODE_DEFAULT_MODEL_ID) {
    return baseModels;
  }

  const slashIndex = selectedId.indexOf('/');
  const label = slashIndex > 0
    ? selectedId.slice(slashIndex + 1)
    : selectedId;

  return [
    ...baseModels,
    {
      id: selectedId,
      label,
      description: selectedId,
    },
  ];
}

export function resolveOpenCodeVariantKeys(
  models: ModelInfo[],
  selectedModelId: string,
  defaultModelId?: string,
): string[] {
  const selectedId = asNonEmptyString(selectedModelId);
  if (!selectedId) {
    return [];
  }

  const resolvedModelId = selectedId === OPENCODE_DEFAULT_MODEL_ID
    ? asNonEmptyString(defaultModelId)
    : selectedId;
  if (!resolvedModelId) {
    return [];
  }

  const model = models.find((entry) => entry.id === resolvedModelId);
  return model?.variants ?? [];
}

export function buildOpenCodeVariantOptions(variantKeys: string[]): Array<{ id: string; label: string }> {
  if (variantKeys.length === 0) {
    return [];
  }
  const options = ['default', ...variantKeys];
  if (options.length <= 2) {
    return [];
  }
  return options.map((id) => ({
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
  }));
}
