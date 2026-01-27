import { useState, useCallback } from 'react';
import type { CodexProviderConfig } from '../../../types/provider';
import { STORAGE_KEYS } from '../../../types/provider';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // sendToJava 不可用时静默处理，避免生产环境日志污染
};

/**
 * 安全地设置 localStorage 并派发自定义事件通知同标签页的其他组件
 * @param key localStorage key
 * @param value 要存储的值
 * @returns 是否成功
 */
function safeSetLocalStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    // 派发自定义事件，通知同标签页内的其他组件
    window.dispatchEvent(new CustomEvent('localStorageChange', { detail: { key } }));
    return true;
  } catch (e) {
    console.warn(`Failed to save to localStorage (key: ${key}):`, e);
    return false;
  }
}

export interface CodexProviderDialogState {
  isOpen: boolean;
  provider: CodexProviderConfig | null;
}

export interface DeleteCodexConfirmState {
  isOpen: boolean;
  provider: CodexProviderConfig | null;
}

export interface UseCodexProviderManagementOptions {
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

export function useCodexProviderManagement(options: UseCodexProviderManagementOptions = {}) {
  const { onSuccess } = options;

  // Codex Provider 列表状态
  const [codexProviders, setCodexProviders] = useState<CodexProviderConfig[]>([]);
  const [codexLoading, setCodexLoading] = useState(false);

  // Codex 配置（保留用于将来显示）
  const [_codexConfig, setCodexConfig] = useState<any>(null);
  const [_codexConfigLoading, setCodexConfigLoading] = useState(false);

  // Codex 供应商弹窗状态
  const [codexProviderDialog, setCodexProviderDialog] = useState<CodexProviderDialogState>({
    isOpen: false,
    provider: null,
  });

  // Codex 供应商删除确认状态
  const [deleteCodexConfirm, setDeleteCodexConfirm] = useState<DeleteCodexConfirmState>({
    isOpen: false,
    provider: null,
  });

  // 加载 Codex Provider 列表
  const loadCodexProviders = useCallback(() => {
    setCodexLoading(true);
    sendToJava('get_codex_providers:');
  }, []);

  // 更新 Codex Provider 列表（供 window callback 使用）
  const updateCodexProviders = useCallback((providersList: CodexProviderConfig[]) => {
    setCodexProviders(providersList);
    setCodexLoading(false);
  }, []);

  // 更新激活的 Codex Provider（供 window callback 使用）
  const updateActiveCodexProvider = useCallback((activeProvider: CodexProviderConfig) => {
    if (activeProvider) {
      setCodexProviders((prev) =>
        prev.map((p) => ({ ...p, isActive: p.id === activeProvider.id }))
      );
      // 同步 customModels 到 localStorage
      safeSetLocalStorage(
        STORAGE_KEYS.CODEX_CUSTOM_MODELS,
        JSON.stringify(activeProvider.customModels || [])
      );
    }
  }, []);

  // 更新 Codex 配置（供 window callback 使用）
  const updateCurrentCodexConfig = useCallback((config: any) => {
    setCodexConfig(config);
    setCodexConfigLoading(false);
  }, []);

  // 打开添加 Codex Provider 弹窗
  const handleAddCodexProvider = useCallback(() => {
    setCodexProviderDialog({ isOpen: true, provider: null });
  }, []);

  // 打开编辑 Codex Provider 弹窗
  const handleEditCodexProvider = useCallback((provider: CodexProviderConfig) => {
    setCodexProviderDialog({ isOpen: true, provider });
  }, []);

  // 关闭 Codex Provider 弹窗
  const handleCloseCodexProviderDialog = useCallback(() => {
    setCodexProviderDialog({ isOpen: false, provider: null });
  }, []);

  // 保存 Codex Provider
  const handleSaveCodexProvider = useCallback(
    (providerData: CodexProviderConfig) => {
      const isAdding = !codexProviderDialog.provider;

      if (isAdding) {
        sendToJava(`add_codex_provider:${JSON.stringify(providerData)}`);
        onSuccess?.('Codex 供应商已添加');
      } else {
        const updateData = {
          id: providerData.id,
          updates: {
            name: providerData.name,
            remark: providerData.remark,
            configToml: providerData.configToml,
            authJson: providerData.authJson,
            customModels: providerData.customModels,
          },
        };
        sendToJava(`update_codex_provider:${JSON.stringify(updateData)}`);
        onSuccess?.('Codex 供应商已更新');
      }

      // 如果更新的是当前激活的 provider，同步 customModels 到 localStorage
      const activeProvider = codexProviders.find(p => p.isActive);
      if (activeProvider && activeProvider.id === providerData.id) {
        safeSetLocalStorage(
          STORAGE_KEYS.CODEX_CUSTOM_MODELS,
          JSON.stringify(providerData.customModels || [])
        );
      }

      setCodexProviderDialog({ isOpen: false, provider: null });
      setCodexLoading(true);
    },
    [codexProviderDialog.provider, codexProviders, onSuccess]
  );

  // 切换 Codex Provider
  const handleSwitchCodexProvider = useCallback((id: string) => {
    const data = { id };
    sendToJava(`switch_codex_provider:${JSON.stringify(data)}`);
    setCodexLoading(true);
  }, []);

  // 删除 Codex Provider
  const handleDeleteCodexProvider = useCallback((provider: CodexProviderConfig) => {
    setDeleteCodexConfirm({ isOpen: true, provider });
  }, []);

  // 确认删除 Codex Provider
  const confirmDeleteCodexProvider = useCallback(() => {
    const provider = deleteCodexConfirm.provider;
    if (!provider) return;

    const data = { id: provider.id };
    sendToJava(`delete_codex_provider:${JSON.stringify(data)}`);
    onSuccess?.('Codex 供应商已删除');
    setCodexLoading(true);
    setDeleteCodexConfirm({ isOpen: false, provider: null });
  }, [deleteCodexConfirm.provider, onSuccess]);

  // 取消删除 Codex Provider
  const cancelDeleteCodexProvider = useCallback(() => {
    setDeleteCodexConfirm({ isOpen: false, provider: null });
  }, []);

  return {
    // 状态
    codexProviders,
    codexLoading,
    codexProviderDialog,
    deleteCodexConfirm,

    // 方法
    loadCodexProviders,
    updateCodexProviders,
    updateActiveCodexProvider,
    updateCurrentCodexConfig,
    handleAddCodexProvider,
    handleEditCodexProvider,
    handleCloseCodexProviderDialog,
    handleSaveCodexProvider,
    handleSwitchCodexProvider,
    handleDeleteCodexProvider,
    confirmDeleteCodexProvider,
    cancelDeleteCodexProvider,

    // Setter
    setCodexLoading,
    setCodexConfigLoading,
  };
}

export type UseCodexProviderManagementReturn = ReturnType<typeof useCodexProviderManagement>;
