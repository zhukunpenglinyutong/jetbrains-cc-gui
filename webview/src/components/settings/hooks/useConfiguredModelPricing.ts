import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CodexCustomModel, ModelPricing } from '../../../types/provider';
import { isValidModelPricing, STORAGE_KEYS } from '../../../types/provider';
import type { ClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { readGlobalClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { sendBridgeEvent } from '../../../utils/bridge';

function normalizeModelId(modelId: string): string {
  return modelId.trim();
}

function normalizeComparableModelId(modelId: string): string {
  return normalizeModelId(modelId).replace(/\[1m\]$/i, '');
}

function readPricingMap(storageKey: string): Record<string, ModelPricing> {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) {
      return {};
    }
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.entries(parsed as Record<string, unknown>).reduce<Record<string, ModelPricing>>((acc, [modelId, pricing]) => {
      const normalizedModelId = normalizeModelId(modelId);
      const pricingModelId = normalizeComparableModelId(normalizedModelId);
      if (pricingModelId && isValidModelPricing(pricing)) {
        acc[pricingModelId] = pricing as ModelPricing;
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function pricingMapToModels(pricingByModel: Record<string, ModelPricing>): CodexCustomModel[] {
  return Object.entries(pricingByModel).map(([id, pricing]) => ({
    id,
    label: id,
    pricing,
  }));
}

function writePricingMap(storageKey: string, pricingByModel: Record<string, ModelPricing>) {
  try {
    if (Object.keys(pricingByModel).length === 0) {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, JSON.stringify(pricingByModel));
    }
    window.dispatchEvent(new CustomEvent('localStorageChange', { detail: { key: storageKey } }));
  } catch {
    // localStorage write failure (for example quota exceeded)
  }
}

function mappingValues(mapping: ClaudeModelMapping): string[] {
  const values = [mapping.main, mapping.haiku, mapping.sonnet, mapping.opus];
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach(value => {
    const modelId = normalizeModelId(value || '');
    if (!modelId) {
      return;
    }
    const comparable = normalizeComparableModelId(modelId).toLowerCase();
    if (seen.has(comparable)) {
      return;
    }
    seen.add(comparable);
    result.push(modelId);
  });

  return result;
}

function mergeConfiguredPricingModels(
  customModels: CodexCustomModel[],
  configuredPricingModels: CodexCustomModel[],
): CodexCustomModel[] {
  return [...customModels, ...configuredPricingModels];
}

function syncClaudePricingModels(customModels: CodexCustomModel[], configuredPricingModels: CodexCustomModel[]) {
  sendBridgeEvent('set_custom_model_pricing', JSON.stringify({
    provider: 'claude',
    models: mergeConfiguredPricingModels(customModels, configuredPricingModels),
  }));
}

/**
 * Manages pricing for Claude models that come from provider/settings.json mappings.
 *
 * These models are already selectable through the mapped built-in Claude entries, so this hook
 * stores only pricing metadata and never adds them to the custom model selector list.
 */
export function useConfiguredClaudeModelPricing(customModels: CodexCustomModel[]) {
  const [pricingByModel, setPricingByModel] = useState<Record<string, ModelPricing>>(
    () => readPricingMap(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING),
  );
  const [mappingVersion, setMappingVersion] = useState(0);

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING) {
        setPricingByModel(readPricingMap(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING));
      }
      if (e.key === STORAGE_KEYS.CLAUDE_MODEL_MAPPING) {
        setMappingVersion(version => version + 1);
      }
    };
    const handleCustomChange = (e: Event) => {
      const detail = (e as CustomEvent<{ key?: string }>).detail;
      if (detail?.key === STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING) {
        setPricingByModel(readPricingMap(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING));
      }
      if (detail?.key === STORAGE_KEYS.CLAUDE_MODEL_MAPPING) {
        setMappingVersion(version => version + 1);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('localStorageChange', handleCustomChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('localStorageChange', handleCustomChange);
    };
  }, []);

  const configuredModels = useMemo<CodexCustomModel[]>(() => {
    const mappedModels = mappingValues(readGlobalClaudeModelMapping());
    return mappedModels.map(modelId => ({
      id: modelId,
      label: modelId,
      pricing: pricingByModel[normalizeComparableModelId(modelId)],
    }));
  }, [mappingVersion, pricingByModel]);

  const updateConfiguredModelPricing = useCallback((modelId: string, pricing?: ModelPricing) => {
    const normalizedModelId = normalizeModelId(modelId);
    const pricingModelId = normalizeComparableModelId(normalizedModelId);
    if (!pricingModelId) {
      return;
    }

    const nextPricingByModel = {
      ...readPricingMap(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING),
      ...pricingByModel,
    };
    if (pricing && isValidModelPricing(pricing)) {
      nextPricingByModel[pricingModelId] = pricing;
    } else {
      delete nextPricingByModel[pricingModelId];
    }

    setPricingByModel(nextPricingByModel);
    writePricingMap(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING, nextPricingByModel);

    syncClaudePricingModels(customModels, pricingMapToModels(nextPricingByModel));
  }, [customModels, pricingByModel]);

  return {
    configuredModels,
    updateConfiguredModelPricing,
  };
}
