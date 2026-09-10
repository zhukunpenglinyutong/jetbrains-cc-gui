import { useTranslation } from 'react-i18next';
import type { AlertType } from '../../AlertDialog';
import type { ToastMessage } from '../../Toast';
import type { UseProviderManagementReturn } from './useProviderManagement';

export interface SaveProviderFromDialogData {
  providerName: string;
  remark: string;
  apiKey: string;
  apiUrl: string;
  jsonConfig: string;
}

interface SaveProviderFromDialogDeps {
  providerDialog: UseProviderManagementReturn['providerDialog'];
  providers: UseProviderManagementReturn['providers'];
  syncActiveProviderModelMapping: UseProviderManagementReturn['syncActiveProviderModelMapping'];
  handleCloseProviderDialog: UseProviderManagementReturn['handleCloseProviderDialog'];
  setLoading: UseProviderManagementReturn['setLoading'];
  showAlert: (type: AlertType, title: string, message: string) => void;
  addToast: (message: string, type?: ToastMessage['type']) => void;
}

// Save provider (wrapper function with validation logic)
export function useSaveProviderFromDialog({
  providerDialog,
  providers,
  syncActiveProviderModelMapping,
  handleCloseProviderDialog,
  setLoading,
  showAlert,
  addToast,
}: SaveProviderFromDialogDeps) {
  const { t } = useTranslation();

  const handleSaveProviderFromDialog = (data: SaveProviderFromDialogData) => {
    if (!data.providerName) {
      showAlert('warning', t('common.warning'), t('toast.pleaseEnterProviderName'));
      return;
    }

    // Parse JSON configuration
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(data.jsonConfig || '{}');
    } catch (e) {
      showAlert('error', t('common.error'), t('toast.invalidJsonConfig'));
      return;
    }

    const updates: Record<string, any> = {
      name: data.providerName,
      remark: data.remark,
      websiteUrl: null, // Clear potentially existing legacy field to avoid display confusion
      settingsConfig: parsedConfig,
    };

    const isAdding = !providerDialog.provider;

    if (isAdding) {
      // Add new provider
      const newProvider = {
        id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
        ...updates
      };
      window.sendToJava?.(`add_provider:${JSON.stringify(newProvider)}`);
      addToast(t('toast.providerAdded'), 'success');
    } else {
      // Update existing provider
      if (!providerDialog.provider) return;

      const providerId = providerDialog.provider.id;
      // Check if the currently edited provider is active
      // Prefer the latest state from providers list; fall back to dialog state if not found
      const currentProviderItem = providers.find(p => p.id === providerId) || providerDialog.provider;
      const isActive = currentProviderItem.isActive;

      const updateData = {
        id: providerId,
        updates,
      };
      window.sendToJava?.(`update_provider:${JSON.stringify(updateData)}`);
      addToast(t('toast.providerUpdated'), 'success');

      // If this is the currently active provider, immediately re-apply the configuration after update
      if (isActive) {
        syncActiveProviderModelMapping({
          ...currentProviderItem,
          settingsConfig: parsedConfig,
        });
        // Use setTimeout for a slight delay to ensure update_provider finishes first
        setTimeout(() => {
          window.sendToJava?.(`switch_provider:${JSON.stringify({ id: providerId })}`);
        }, 100);
      }
    }

    handleCloseProviderDialog();
    setLoading(true);
  };

  return handleSaveProviderFromDialog;
}
