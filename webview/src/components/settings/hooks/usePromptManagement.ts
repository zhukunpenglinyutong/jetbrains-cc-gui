import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptConfig } from '../../../types/prompt';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // Silently ignore when sendToJava is unavailable to avoid log pollution in production
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
  const { t } = useTranslation();

  // Timeout timer reference (using useRef to avoid global variable pollution)
  const promptsLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prompt list state
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);

  // Prompt dialog state
  const [promptDialog, setPromptDialog] = useState<PromptDialogState>({
    isOpen: false,
    prompt: null,
  });

  // Prompt delete confirmation state
  const [deletePromptConfirm, setDeletePromptConfirm] = useState<DeletePromptConfirmState>({
    isOpen: false,
    prompt: null,
  });

  // Load prompt list (with timeout protection, no retries)
  const loadPrompts = useCallback(() => {
    const TIMEOUT = 2000; // 2-second timeout

    setPromptsLoading(true);
    sendToJava('get_prompts:');

    // Set up timeout timer - show empty list after timeout
    const timeoutId = setTimeout(() => {
      // Stop loading after timeout, show empty list
      setPromptsLoading(false);
      // Don't clear the list, preserve any existing data
    }, TIMEOUT);

    // Store timeout ID in ref
    promptsLoadingTimeoutRef.current = timeoutId;
  }, []);

  // Update prompt list (used by window callback)
  const updatePrompts = useCallback((promptsList: PromptConfig[]) => {
    // Clear timeout timer
    if (promptsLoadingTimeoutRef.current) {
      clearTimeout(promptsLoadingTimeoutRef.current);
      promptsLoadingTimeoutRef.current = null;
    }

    setPrompts(promptsList);
    setPromptsLoading(false);
  }, []);

  // Clean up timeout timer
  const cleanupPromptsTimeout = useCallback(() => {
    if (promptsLoadingTimeoutRef.current) {
      clearTimeout(promptsLoadingTimeoutRef.current);
      promptsLoadingTimeoutRef.current = null;
    }
  }, []);

  // Open add prompt dialog
  const handleAddPrompt = useCallback(() => {
    setPromptDialog({ isOpen: true, prompt: null });
  }, []);

  // Open edit prompt dialog
  const handleEditPrompt = useCallback((prompt: PromptConfig) => {
    setPromptDialog({ isOpen: true, prompt });
  }, []);

  // Close prompt dialog
  const handleClosePromptDialog = useCallback(() => {
    setPromptDialog({ isOpen: false, prompt: null });
  }, []);

  // Delete prompt
  const handleDeletePrompt = useCallback((prompt: PromptConfig) => {
    setDeletePromptConfirm({ isOpen: true, prompt });
  }, []);

  // Save prompt
  const handleSavePrompt = useCallback(
    (data: { name: string; content: string }) => {
      const isAdding = !promptDialog.prompt;

      if (isAdding) {
        // Add new prompt
        const newPrompt = {
          id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
          name: data.name,
          content: data.content,
          createdAt: Date.now(),
        };
        sendToJava(`add_prompt:${JSON.stringify(newPrompt)}`);
      } else if (promptDialog.prompt) {
        // Update existing prompt
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
      // Reload list after prompt operation (with timeout protection)
      loadPrompts();
    },
    [promptDialog.prompt, loadPrompts]
  );

  // Confirm prompt deletion
  const confirmDeletePrompt = useCallback(() => {
    const prompt = deletePromptConfirm.prompt;
    if (!prompt) return;

    const data = { id: prompt.id };
    sendToJava(`delete_prompt:${JSON.stringify(data)}`);
    setDeletePromptConfirm({ isOpen: false, prompt: null });
    // Reload list after deletion (with timeout protection)
    loadPrompts();
  }, [deletePromptConfirm.prompt, loadPrompts]);

  // Cancel prompt deletion
  const cancelDeletePrompt = useCallback(() => {
    setDeletePromptConfirm({ isOpen: false, prompt: null });
  }, []);

  // Handle prompt operation result (used by window callback)
  const handlePromptOperationResult = useCallback(
    (result: { success: boolean; operation?: string; error?: string }) => {
      if (result.success) {
        const operationMessages: Record<string, string> = {
          add: t('settings.prompt.addSuccess'),
          update: t('settings.prompt.updateSuccess'),
          delete: t('settings.prompt.deleteSuccess'),
        };
        onSuccess?.(operationMessages[result.operation || ''] || t('settings.prompt.operationSuccess'));
      }
    },
    [onSuccess, t]
  );

  return {
    // State
    prompts,
    promptsLoading,
    promptDialog,
    deletePromptConfirm,

    // Methods
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
