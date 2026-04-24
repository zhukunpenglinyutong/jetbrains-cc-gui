import { useState, useCallback, useEffect } from 'react';
import type { CodexCustomModel } from '../../../types/provider';
import { validateCodexCustomModels, STORAGE_KEYS } from '../../../types/provider';
import { sendBridgeEvent } from '../../../utils/bridge';

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

    // Also save to backend configuration file for git dialog access
    saveCustomModelsToBackend();
  } catch {
    // localStorage write failure (e.g. quota exceeded)
  }
}

/**
 * Save all plugin-level custom models to the backend configuration file.
 * This ensures custom models are available in the git commit dialog.
 * @param forceSync - Force sync even if models are empty (for initialization)
 */
function saveCustomModelsToBackend(forceSync = false) {
  try {
    const claudeModels = JSON.parse(localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS) || '[]');
    const codexModels = JSON.parse(localStorage.getItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS) || '[]');

    // Only sync if there are models or force sync is requested
    if (!forceSync && claudeModels.length === 0 && codexModels.length === 0) {
      return;
    }

    const payload = {
      claude: claudeModels,
      codex: codexModels,
    };

    console.debug('[usePluginModels] Syncing custom models to backend:', payload);
    sendBridgeEvent('save_custom_models', JSON.stringify(payload));
  } catch (e) {
    console.debug('[usePluginModels] Failed to save custom models to backend:', e);
  }
}

/** Custom event detail shape for localStorageChange */
interface LocalStorageChangeDetail {
  key: string;
}

/**
 * Sync custom Claude models to the active provider configuration.
 * This ensures the backend can access custom models for dialogs like git commit.
 */
function syncClaudeCustomModelsToProvider(models: CodexCustomModel[]) {
  try {
    // Get active provider from localStorage (set by the backend)
    const activeProviderStr = localStorage.getItem('activeProvider');
    if (!activeProviderStr) {
      console.debug('[usePluginModels] No active provider in localStorage, skipping sync');
      return;
    }

    const activeProvider = JSON.parse(activeProviderStr);
    if (!activeProvider || !activeProvider.id) {
      console.debug('[usePluginModels] Invalid active provider, skipping sync');
      return;
    }

    // Skip special providers that don't support custom models
    if (activeProvider.id === '__disabled__' ||
        activeProvider.id === '__local_settings_json__' ||
        activeProvider.id === '__cli_login__') {
      console.debug('[usePluginModels] Special provider detected, skipping sync:', activeProvider.id);
      return;
    }

    // Send update_provider message to sync custom models
    const updateData = {
      id: activeProvider.id,
      updates: {
        customModels: models,
      },
    };
    console.debug('[usePluginModels] Syncing custom models to provider:', activeProvider.id, models);
    window.sendToJava?.(`update_provider:${JSON.stringify(updateData)}`);
  } catch (e) {
    // Silently fail - provider sync is optional
    console.debug('[usePluginModels] Failed to sync custom models to provider:', e);
  }
}

/**
 * Hook to manage plugin-level custom models with localStorage persistence.
 * Listens for both native StorageEvent (cross-tab) and custom localStorageChange (same-tab) events.
 * For Claude custom models, also syncs to the active provider configuration for backend access.
 *
 * On first mount, syncs existing custom models from localStorage to backend configuration file.
 */
export function usePluginModels(storageKey: string) {
  const [models, setModels] = useState<CodexCustomModel[]>(() => readPluginModels(storageKey));
  const [hasInitialized, setHasInitialized] = useState(false);

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

  // Initialize: sync existing custom models to backend on first mount
  useEffect(() => {
    if (hasInitialized) return;

    // Sync all custom models (both Claude and Codex) to backend
    saveCustomModelsToBackend(true);
    setHasInitialized(true);
  }, [hasInitialized]);

  const updateModels = useCallback((newModels: CodexCustomModel[]) => {
    setModels(newModels);
    writePluginModels(storageKey, newModels);

    // Sync Claude custom models to provider config for backend access
    if (storageKey === STORAGE_KEYS.CLAUDE_CUSTOM_MODELS) {
      syncClaudeCustomModelsToProvider(newModels);
    }
  }, [storageKey]);

  return { models, updateModels };
}
