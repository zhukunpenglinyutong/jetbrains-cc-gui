import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../../../types/provider';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // Silently ignore when sendToJava is unavailable to avoid log pollution in production
};

export interface ProviderDialogState {
  isOpen: boolean;
  provider: ProviderConfig | null;
}

export interface DeleteConfirmState {
  isOpen: boolean;
  provider: ProviderConfig | null;
}

export interface SnapshotInfo {
  exists: boolean;
  timestamp: string;
}

export interface UseProviderManagementOptions {
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

export function useProviderManagement(options: UseProviderManagementOptions = {}) {
  const { t } = useTranslation();
  const { onError, onSuccess } = options;

  // Provider list state
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(false);

  // Snapshot state
  const [snapshotInfo, setSnapshotInfo] = useState<SnapshotInfo>({
    exists: false,
    timestamp: '',
  });
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  // Provider dialog state
  const [providerDialog, setProviderDialog] = useState<ProviderDialogState>({
    isOpen: false,
    provider: null,
  });

  // Delete confirmation dialog state
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    isOpen: false,
    provider: null,
  });

  // Sync active provider model mapping to localStorage
  const syncActiveProviderModelMapping = useCallback((provider?: ProviderConfig | null) => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!provider || !provider.settingsConfig || !provider.settingsConfig.env) {
      try {
        window.localStorage.removeItem('claude-model-mapping');
      } catch {
        // ignore
      }
      return;
    }
    const env = provider.settingsConfig.env as Record<string, any>;
    const mapping = {
      main: env.ANTHROPIC_MODEL ?? '',
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
    };
    const hasValue = Object.values(mapping).some((v) => v && String(v).trim().length > 0);
    try {
      if (hasValue) {
        window.localStorage.setItem('claude-model-mapping', JSON.stringify(mapping));
      } else {
        window.localStorage.removeItem('claude-model-mapping');
      }
    } catch {
      // ignore
    }
  }, []);

  // Load provider list
  const loadProviders = useCallback(() => {
    setLoading(true);
    sendToJava('get_providers:');
  }, []);

  // Update provider list (used by window callback)
  const updateProviders = useCallback(
    (providersList: ProviderConfig[]) => {
      setProviders(providersList);
      const active = providersList.find((p) => p.isActive);
      if (active) {
        syncActiveProviderModelMapping(active);
      }
      setLoading(false);
    },
    [syncActiveProviderModelMapping]
  );

  // Update active provider (used by window callback)
  const updateActiveProvider = useCallback(
    (activeProvider: ProviderConfig) => {
      if (activeProvider) {
        setProviders((prev) =>
          prev.map((p) => ({ ...p, isActive: p.id === activeProvider.id }))
        );
        syncActiveProviderModelMapping(activeProvider);
      }
    },
    [syncActiveProviderModelMapping]
  );

  // Open edit dialog
  const handleEditProvider = useCallback((provider: ProviderConfig) => {
    setProviderDialog({ isOpen: true, provider });
  }, []);

  // Open add dialog
  const handleAddProvider = useCallback(() => {
    setProviderDialog({ isOpen: true, provider: null });
  }, []);

  // Close dialog
  const handleCloseProviderDialog = useCallback(() => {
    setProviderDialog({ isOpen: false, provider: null });
  }, []);

  // Save provider
  const handleSaveProvider = useCallback(
    (data: {
      providerName: string;
      remark: string;
      apiKey: string;
      apiUrl: string;
      jsonConfig: string;
    }) => {
      if (!data.providerName) {
        onError?.(t('toast.pleaseEnterProviderName'));
        return false;
      }

      let parsedConfig;
      try {
        parsedConfig = JSON.parse(data.jsonConfig || '{}');
      } catch (e) {
        onError?.(t('toast.invalidJsonConfig'));
        return false;
      }

      const updates = {
        name: data.providerName,
        remark: data.remark,
        websiteUrl: null,
        settingsConfig: parsedConfig,
      };

      const isAdding = !providerDialog.provider;

      if (isAdding) {
        const newProvider = {
          id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
          ...updates,
        };
        sendToJava(`add_provider:${JSON.stringify(newProvider)}`);
        onSuccess?.(t('toast.providerAdded'));
      } else {
        if (!providerDialog.provider) return false;

        const providerId = providerDialog.provider.id;
        const currentProvider =
          providers.find((p) => p.id === providerId) || providerDialog.provider;
        const isActive = currentProvider.isActive;

        const updateData = {
          id: providerId,
          updates,
        };
        sendToJava(`update_provider:${JSON.stringify(updateData)}`);
        onSuccess?.(t('toast.providerUpdated'));

        if (isActive) {
          syncActiveProviderModelMapping({
            ...currentProvider,
            settingsConfig: parsedConfig,
          });
          setTimeout(() => {
            sendToJava(`switch_provider:${JSON.stringify({ id: providerId })}`);
          }, 100);
        }
      }

      setProviderDialog({ isOpen: false, provider: null });
      setLoading(true);
      return true;
    },
    [providerDialog.provider, providers, syncActiveProviderModelMapping, onError, onSuccess]
  );

  // Switch provider
  const handleSwitchProvider = useCallback(
    (id: string) => {
      const data = { id };
      const target = providers.find((p) => p.id === id);
      if (target) {
        syncActiveProviderModelMapping(target);
      }
      sendToJava(`switch_provider:${JSON.stringify(data)}`);
      setLoading(true);
    },
    [providers, syncActiveProviderModelMapping]
  );

  // Delete provider
  const handleDeleteProvider = useCallback((provider: ProviderConfig) => {
    setDeleteConfirm({ isOpen: true, provider });
  }, []);

  // Confirm deletion
  const confirmDeleteProvider = useCallback(() => {
    const provider = deleteConfirm.provider;
    if (!provider) return;

    const data = { id: provider.id };
    sendToJava(`delete_provider:${JSON.stringify(data)}`);
    onSuccess?.(t('toast.providerDeleted'));
    setLoading(true);
    setDeleteConfirm({ isOpen: false, provider: null });
  }, [deleteConfirm.provider, onSuccess]);

  // Cancel deletion
  const cancelDeleteProvider = useCallback(() => {
    setDeleteConfirm({ isOpen: false, provider: null });
  }, []);

  // Load snapshot info
  const loadSnapshotInfo = useCallback(() => {
    sendToJava('get_snapshot_info:');
  }, []);

  // Update snapshot info (used by window callback)
  const updateSnapshotInfo = useCallback((info: SnapshotInfo) => {
    setSnapshotInfo(info);
  }, []);

  // Save snapshot
  const handleSaveSnapshot = useCallback(() => {
    setSnapshotLoading(true);
    sendToJava('save_local_snapshot:');
  }, []);

  // Restore snapshot
  const handleRestoreSnapshot = useCallback(() => {
    setSnapshotLoading(true);
    sendToJava('restore_local_snapshot:');
  }, []);

  // Snapshot saved callback
  const onSnapshotSaved = useCallback(
    (response: { success: boolean; timestamp?: string; error?: string }) => {
      setSnapshotLoading(false);
      if (response.success) {
        onSuccess?.(t('toast.snapshotSaved'));
        loadSnapshotInfo();
      } else {
        onError?.(t('toast.snapshotSaveFailed') + (response.error ? `: ${response.error}` : ''));
      }
    },
    [onSuccess, onError, t, loadSnapshotInfo]
  );

  // Snapshot restored callback
  const onSnapshotRestored = useCallback(
    (response: { success: boolean; error?: string }) => {
      setSnapshotLoading(false);
      if (response.success) {
        onSuccess?.(t('toast.snapshotRestored'));
        // Auto-switch to local provider after successful restore
        const localProviderId = '__local_settings_json__';
        sendToJava(`switch_provider:${JSON.stringify({ id: localProviderId })}`);
        setLoading(true);
      } else if (response.error) {
        onError?.(t('toast.snapshotRestoreFailed') + `: ${response.error}`);
      } else {
        onError?.(t('toast.snapshotNotFound'));
      }
    },
    [onSuccess, onError, t]
  );

  return {
    // State
    providers,
    loading,
    providerDialog,
    deleteConfirm,
    snapshotInfo,
    snapshotLoading,

    // Methods
    loadProviders,
    updateProviders,
    updateActiveProvider,
    handleEditProvider,
    handleAddProvider,
    handleCloseProviderDialog,
    handleSaveProvider,
    handleSwitchProvider,
    handleDeleteProvider,
    confirmDeleteProvider,
    cancelDeleteProvider,
    syncActiveProviderModelMapping,
    loadSnapshotInfo,
    updateSnapshotInfo,
    handleSaveSnapshot,
    handleRestoreSnapshot,
    onSnapshotSaved,
    onSnapshotRestored,

    // Setter (for external loading state control)
    setLoading,
  };
}

export type UseProviderManagementReturn = ReturnType<typeof useProviderManagement>;
