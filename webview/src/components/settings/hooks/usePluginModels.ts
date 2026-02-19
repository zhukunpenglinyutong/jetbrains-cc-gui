import { useState, useCallback, useEffect } from 'react';
import type { CodexCustomModel } from '../../../types/provider';
import { validateCodexCustomModels } from '../../../types/provider';

/**
 * Read plugin-level custom models from localStorage
 */
function readPluginModels(storageKey: string): CodexCustomModel[] {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return validateCodexCustomModels(parsed);
  } catch {
    return [];
  }
}

/**
 * Write plugin-level custom models to localStorage and notify listeners
 */
function writePluginModels(storageKey: string, models: CodexCustomModel[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(models));
    window.dispatchEvent(new CustomEvent('localStorageChange', { detail: { key: storageKey } }));
  } catch {
    // localStorage write failure (e.g. quota exceeded)
  }
}

/** Custom event detail shape for localStorageChange */
interface LocalStorageChangeDetail {
  key: string;
}

/**
 * Hook to manage plugin-level custom models with localStorage persistence.
 * Listens for both native StorageEvent (cross-tab) and custom localStorageChange (same-tab) events.
 */
export function usePluginModels(storageKey: string) {
  const [models, setModels] = useState<CodexCustomModel[]>(() => readPluginModels(storageKey));

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === storageKey) {
        setModels(readPluginModels(storageKey));
      }
    };
    const handleCustomChange = (e: Event) => {
      const detail = (e as CustomEvent<LocalStorageChangeDetail>).detail;
      if (detail?.key === storageKey) {
        setModels(readPluginModels(storageKey));
      }
    };
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('localStorageChange', handleCustomChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('localStorageChange', handleCustomChange);
    };
  }, [storageKey]);

  const updateModels = useCallback((newModels: CodexCustomModel[]) => {
    setModels(newModels);
    writePluginModels(storageKey, newModels);
  }, [storageKey]);

  return { models, updateModels };
}
