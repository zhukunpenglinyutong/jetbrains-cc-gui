import { useState, useCallback, useRef } from 'react';
import type { PromptConfig } from '../../../types/prompt';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // sendToJava 不可用时静默处理，避免生产环境日志污染
};

export interface PromptDialogState {
  isOpen: boolean;
  prompt: PromptConfig | null;
}

export interface DeletePromptConfirmState {
  isOpen: boolean;
  prompt: PromptConfig | null;
}

export interface UsePromptManagementOptions {
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

export function usePromptManagement(options: UsePromptManagementOptions = {}) {
  const { onSuccess } = options;

  // 超时定时器引用（使用 useRef 避免全局变量污染）
  const promptsLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prompt 列表状态
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);

  // Prompt 弹窗状态
  const [promptDialog, setPromptDialog] = useState<PromptDialogState>({
    isOpen: false,
    prompt: null,
  });

  // Prompt 删除确认状态
  const [deletePromptConfirm, setDeletePromptConfirm] = useState<DeletePromptConfirmState>({
    isOpen: false,
    prompt: null,
  });

  // 加载 Prompt 列表（带超时保护，不再重试）
  const loadPrompts = useCallback(() => {
    const TIMEOUT = 2000; // 2秒超时

    setPromptsLoading(true);
    sendToJava('get_prompts:');

    // 设置超时定时器 - 超时后直接显示空列表
    const timeoutId = setTimeout(() => {
      // 超时后停止加载，显示空列表
      setPromptsLoading(false);
      // 不设置空列表，保留可能已有的数据
    }, TIMEOUT);

    // 使用 ref 存储超时 ID
    promptsLoadingTimeoutRef.current = timeoutId;
  }, []);

  // 更新 Prompt 列表（供 window callback 使用）
  const updatePrompts = useCallback((promptsList: PromptConfig[]) => {
    // 清除超时定时器
    if (promptsLoadingTimeoutRef.current) {
      clearTimeout(promptsLoadingTimeoutRef.current);
      promptsLoadingTimeoutRef.current = null;
    }

    setPrompts(promptsList);
    setPromptsLoading(false);
  }, []);

  // 清理超时定时器
  const cleanupPromptsTimeout = useCallback(() => {
    if (promptsLoadingTimeoutRef.current) {
      clearTimeout(promptsLoadingTimeoutRef.current);
      promptsLoadingTimeoutRef.current = null;
    }
  }, []);

  // 打开添加 Prompt 弹窗
  const handleAddPrompt = useCallback(() => {
    setPromptDialog({ isOpen: true, prompt: null });
  }, []);

  // 打开编辑 Prompt 弹窗
  const handleEditPrompt = useCallback((prompt: PromptConfig) => {
    setPromptDialog({ isOpen: true, prompt });
  }, []);

  // 关闭 Prompt 弹窗
  const handleClosePromptDialog = useCallback(() => {
    setPromptDialog({ isOpen: false, prompt: null });
  }, []);

  // 删除 Prompt
  const handleDeletePrompt = useCallback((prompt: PromptConfig) => {
    setDeletePromptConfirm({ isOpen: true, prompt });
  }, []);

  // 保存 Prompt
  const handleSavePrompt = useCallback(
    (data: { name: string; content: string }) => {
      const isAdding = !promptDialog.prompt;

      if (isAdding) {
        // 添加新提示词
        const newPrompt = {
          id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
          name: data.name,
          content: data.content,
          createdAt: Date.now(),
        };
        sendToJava(`add_prompt:${JSON.stringify(newPrompt)}`);
      } else if (promptDialog.prompt) {
        // 更新现有提示词
        const updateData = {
          id: promptDialog.prompt.id,
          updates: {
            name: data.name,
            content: data.content,
            updatedAt: Date.now(),
          },
        };
        sendToJava(`update_prompt:${JSON.stringify(updateData)}`);
      }

      setPromptDialog({ isOpen: false, prompt: null });
      // 提示词操作后重新加载列表（包含超时保护）
      loadPrompts();
    },
    [promptDialog.prompt, loadPrompts]
  );

  // 确认删除 Prompt
  const confirmDeletePrompt = useCallback(() => {
    const prompt = deletePromptConfirm.prompt;
    if (!prompt) return;

    const data = { id: prompt.id };
    sendToJava(`delete_prompt:${JSON.stringify(data)}`);
    setDeletePromptConfirm({ isOpen: false, prompt: null });
    // 删除后重新加载列表（包含超时保护）
    loadPrompts();
  }, [deletePromptConfirm.prompt, loadPrompts]);

  // 取消删除 Prompt
  const cancelDeletePrompt = useCallback(() => {
    setDeletePromptConfirm({ isOpen: false, prompt: null });
  }, []);

  // 处理 Prompt 操作结果（供 window callback 使用）
  const handlePromptOperationResult = useCallback(
    (result: { success: boolean; operation?: string; error?: string }) => {
      if (result.success) {
        const operationMessages: Record<string, string> = {
          add: '提示词已添加',
          update: '提示词已更新',
          delete: '提示词已删除',
        };
        onSuccess?.(operationMessages[result.operation || ''] || '操作成功');
      }
    },
    [onSuccess]
  );

  return {
    // 状态
    prompts,
    promptsLoading,
    promptDialog,
    deletePromptConfirm,

    // 方法
    loadPrompts,
    updatePrompts,
    cleanupPromptsTimeout,
    handleAddPrompt,
    handleEditPrompt,
    handleClosePromptDialog,
    handleDeletePrompt,
    handleSavePrompt,
    confirmDeletePrompt,
    cancelDeletePrompt,
    handlePromptOperationResult,

    // Setter
    setPromptsLoading,
  };
}

export type UsePromptManagementReturn = ReturnType<typeof usePromptManagement>;
