import { useState, useCallback } from 'react';
import type { ProviderConfig } from '../../../types/provider';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // sendToJava 不可用时静默处理，避免生产环境日志污染
};

export interface ProviderDialogState {
  isOpen: boolean;
  provider: ProviderConfig | null;
}

export interface DeleteConfirmState {
  isOpen: boolean;
  provider: ProviderConfig | null;
}

export interface UseProviderManagementOptions {
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

export function useProviderManagement(options: UseProviderManagementOptions = {}) {
  const { onError, onSuccess } = options;

  // Provider 列表状态
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(false);

  // 供应商弹窗状态
  const [providerDialog, setProviderDialog] = useState<ProviderDialogState>({
    isOpen: false,
    provider: null,
  });

  // 确认删除弹窗状态
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    isOpen: false,
    provider: null,
  });

  // 同步激活的 Provider 模型映射到 localStorage
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

  // 加载 Provider 列表
  const loadProviders = useCallback(() => {
    setLoading(true);
    sendToJava('get_providers:');
  }, []);

  // 更新 Provider 列表（供 window callback 使用）
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

  // 更新激活的 Provider（供 window callback 使用）
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

  // 打开编辑弹窗
  const handleEditProvider = useCallback((provider: ProviderConfig) => {
    setProviderDialog({ isOpen: true, provider });
  }, []);

  // 打开添加弹窗
  const handleAddProvider = useCallback(() => {
    setProviderDialog({ isOpen: true, provider: null });
  }, []);

  // 关闭弹窗
  const handleCloseProviderDialog = useCallback(() => {
    setProviderDialog({ isOpen: false, provider: null });
  }, []);

  // 保存 Provider
  const handleSaveProvider = useCallback(
    (data: {
      providerName: string;
      remark: string;
      apiKey: string;
      apiUrl: string;
      jsonConfig: string;
    }) => {
      if (!data.providerName) {
        onError?.('请输入供应商名称');
        return false;
      }

      let parsedConfig;
      try {
        parsedConfig = JSON.parse(data.jsonConfig || '{}');
      } catch (e) {
        onError?.('JSON 配置格式无效');
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
        onSuccess?.('供应商已添加');
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
        onSuccess?.('供应商已更新');

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

  // 切换 Provider
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

  // 删除 Provider
  const handleDeleteProvider = useCallback((provider: ProviderConfig) => {
    setDeleteConfirm({ isOpen: true, provider });
  }, []);

  // 确认删除
  const confirmDeleteProvider = useCallback(() => {
    const provider = deleteConfirm.provider;
    if (!provider) return;

    const data = { id: provider.id };
    sendToJava(`delete_provider:${JSON.stringify(data)}`);
    onSuccess?.('供应商已删除');
    setLoading(true);
    setDeleteConfirm({ isOpen: false, provider: null });
  }, [deleteConfirm.provider, onSuccess]);

  // 取消删除
  const cancelDeleteProvider = useCallback(() => {
    setDeleteConfirm({ isOpen: false, provider: null });
  }, []);

  return {
    // 状态
    providers,
    loading,
    providerDialog,
    deleteConfirm,

    // 方法
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

    // Setter（用于外部设置 loading 状态）
    setLoading,
  };
}

export type UseProviderManagementReturn = ReturnType<typeof useProviderManagement>;
