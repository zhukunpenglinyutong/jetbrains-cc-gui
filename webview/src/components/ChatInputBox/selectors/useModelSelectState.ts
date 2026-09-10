import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeClaudeModelId, strip1MContextSuffix } from '../types';
import type { ModelInfo } from '../types';
import { readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { resolveModelDescription, resolveModelDisplayLabel } from '../modelLabelUtils';
import {
  buildModelDropdownSections,
  MAX_VISIBLE_MODEL_OPTIONS,
  readPinnedModelIds,
  shouldShowModelSearch,
} from '../modelSelectUtils';

interface UseModelSelectStateArgs {
  value: string;
  models: ModelInfo[];
  currentProvider: string;
  longContextEnabled: boolean;
}

/**
 * Holds ModelSelect's open/search/pinned state plus every derived value
 * (current model resolution, label/description helpers, filtered sections).
 */
export function useModelSelectState({ value, models, currentProvider, longContextEnabled }: UseModelSelectStateArgs) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinnedModelIds(currentProvider));
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // Strip [1m] suffix for finding the model in the list
  const strippedValue = strip1MContextSuffix(value);
  const normalizedValue = currentProvider === 'claude' ? normalizeClaudeModelId(strippedValue) : strippedValue;
  // Prefer the user's selection even when the catalog is still loading / only a
  // static fallback is available. Falling back to models[0] made OpenCode (and
  // other dynamic providers) visually snap back to the first entry after leaving
  // history and remounting ChatScreen.
  const currentModel = models.find(m => m.id === normalizedValue)
    || models.find(m => m.id === strippedValue)
    || (strippedValue
      ? { id: strippedValue, label: strippedValue } as ModelInfo
      : models[0]);
  const modelMapping = readClaudeModelMapping();

  useEffect(() => {
    setPinnedIds(readPinnedModelIds(currentProvider));
  }, [currentProvider]);

  const isSelectedModel = (modelId: string): boolean => {
    if (currentProvider !== 'claude') {
      return modelId === strippedValue;
    }
    return normalizeClaudeModelId(modelId) === normalizedValue;
  };

  const getModelLabel = (model: ModelInfo, show1MContext = false): string => {
    return resolveModelDisplayLabel(model, {
      t,
      currentProvider,
      modelMapping,
      show1MContext,
      longContextEnabled,
    });
  };

  const getModelDescription = (model: ModelInfo): string | undefined => {
    return resolveModelDescription(model, t);
  };

  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const filteredModels = normalizedSearchQuery
    ? models.filter((model) => {
        const label = getModelLabel(model, false);
        const description = getModelDescription(model) ?? '';
        return [model.id, label, description].some((text) => text.toLowerCase().includes(normalizedSearchQuery));
      })
    : models;

  const { sections, hiddenCount: hiddenModelCount } = buildModelDropdownSections(filteredModels, pinnedIds, {
    visibleLimit: MAX_VISIBLE_MODEL_OPTIONS,
  });
  const visibleModelCount = sections.reduce((n, s) => n + s.models.length, 0);
  const showSearch = shouldShowModelSearch(models.length, searchQuery);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  return {
    t,
    isOpen,
    setIsOpen,
    searchQuery,
    setSearchQuery,
    pinnedIds,
    setPinnedIds,
    pinnedSet,
    currentModel,
    modelMapping,
    isSelectedModel,
    getModelLabel,
    getModelDescription,
    filteredModels,
    sections,
    hiddenModelCount,
    visibleModelCount,
    showSearch,
  };
}
