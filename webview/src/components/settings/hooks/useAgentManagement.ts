import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentConfig, GetAgentsMessage } from '../../../types/agent';
import { AGENT_SCOPES } from '../../../types/agent';
import type { ImportPreviewResult, ConflictStrategy } from '../../../types/import';

/** How long a quiet refresh waits before giving up on its answer. */
const REFRESH_TIMEOUT = 3000;

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // Silently ignore when sendToJava is unavailable to avoid log pollution in production
};

export interface AgentDialogState {
  isOpen: boolean;
  agent: AgentConfig | null;
}

export interface DeleteAgentConfirmState {
  isOpen: boolean;
  agent: AgentConfig | null;
}

export interface ImportPreviewDialogState {
  isOpen: boolean;
  previewData: ImportPreviewResult<AgentConfig> | null;
}

export interface ExportDialogState {
  isOpen: boolean;
}

export interface UseAgentManagementOptions {
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

export function useAgentManagement(options: UseAgentManagementOptions = {}) {
  const { t } = useTranslation();
  const { onSuccess, onError } = options;

  // Timeout timer reference (using useRef to avoid global variable pollution)
  const agentsLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Agent list state
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  // Agent dialog state
  const [agentDialog, setAgentDialog] = useState<AgentDialogState>({
    isOpen: false,
    agent: null,
  });

  // Agent delete confirmation state
  const [deleteAgentConfirm, setDeleteAgentConfirm] = useState<DeleteAgentConfirmState>({
    isOpen: false,
    agent: null,
  });

  // Import preview dialog state
  const [importPreviewDialog, setImportPreviewDialog] = useState<ImportPreviewDialogState>({
    isOpen: false,
    previewData: null,
  });

  // Export dialog state
  const [exportDialog, setExportDialog] = useState<ExportDialogState>({
    isOpen: false,
  });

  // Spins on the refresh button while an explicit re-read is in flight. Kept
  // apart from `agentsLoading` on purpose: that one blanks the list, which is
  // right for a first load and wrong for a user who clicked Refresh because
  // they did not believe what they were looking at.
  const [refreshing, setRefreshing] = useState(false);

  // Load agent list (with retry mechanism)
  const loadAgents = useCallback((retryCount = 0) => {
    const MAX_RETRIES = 2;
    const TIMEOUT = 3000; // 3-second timeout

    setAgentsLoading(true);
    // The backend resolves store, ~/.claude/agents and {workspace}/.claude/agents
    // into one list and answers precedence itself; the tab asks for the scopes
    // it wants to display and never decides which definition of a name wins.
    // AGENT_SCOPES keeps this list in step with the server contract.
    const request: GetAgentsMessage = { scopes: [...AGENT_SCOPES] };
    sendToJava(`get_agents:${JSON.stringify(request)}`);

    // Set up timeout timer
    const timeoutId = setTimeout(() => {
      if (retryCount < MAX_RETRIES) {
        // Retry
        loadAgents(retryCount + 1);
      } else {
        // Reached max retries, stop loading
        setAgentsLoading(false);
        setAgents([]); // Show empty list, allow user to continue
      }
    }, TIMEOUT);

    // Store timeout ID in ref
    agentsLoadingTimeoutRef.current = timeoutId;
  }, []);

  /**
   * Re-read the list without flashing the loading state.
   *
   * <p>Used when the backend reports that an agent file changed on disk. The
   * tab is already showing a list the user is looking at; replacing it with a
   * spinner because they saved a file in another window would be a worse
   * answer than the 50 ms the rescan takes. There is no retry loop either: a
   * watcher-driven refresh is a repeat of a request that just succeeded, so
   * retrying it would only re-trigger the watcher.
   *
   * <p>It arms a timeout of its own rather than borrowing the first load's.
   * Clearing that one without replacing it would leave both flags with no way
   * back: a change arriving during the initial load would clear the safety net
   * that was about to clear `agentsLoading`, and a lost answer would strand the
   * tab on "loading" with no way out but reopening Settings. `refreshing` had
   * the same hole, since only `updateAgents` ever cleared it.
   *
   * <p>Unlike the first load, this timeout does not empty the list. A failed
   * background refresh must not destroy the list the user is reading.
   */
  const refreshAgentsQuietly = useCallback(() => {
    if (agentsLoadingTimeoutRef.current) {
      clearTimeout(agentsLoadingTimeoutRef.current);
    }
    const request: GetAgentsMessage = { scopes: [...AGENT_SCOPES] };
    sendToJava(`get_agents:${JSON.stringify(request)}`);

    agentsLoadingTimeoutRef.current = setTimeout(() => {
      agentsLoadingTimeoutRef.current = null;
      setAgentsLoading(false);
      setRefreshing(false);
    }, REFRESH_TIMEOUT);
  }, []);

  /**
   * Re-read the list at the user's request.
   *
   * <p>Same wire request as the quiet refresh, but it marks itself in flight so
   * the button can show that something happened. The list is not blanked: a
   * user who pressed Refresh has a list in front of them, and replacing it with
   * a spinner is a worse answer than an icon that turns for the few dozen
   * milliseconds the scan takes.
   */
  const refreshAgents = useCallback(() => {
    setRefreshing(true);
    refreshAgentsQuietly();
  }, [refreshAgentsQuietly]);

  // Update agent list (used by window callback)
  const updateAgents = useCallback((agentsList: AgentConfig[]) => {
    // Whatever answer arrives ends an explicit refresh; the request is the same
    // one, so there is nothing to distinguish.
    setRefreshing(false);
    // Clear timeout timer
    if (agentsLoadingTimeoutRef.current) {
      clearTimeout(agentsLoadingTimeoutRef.current);
      agentsLoadingTimeoutRef.current = null;
    }

    setAgents(agentsList);
    setAgentsLoading(false);
  }, []);

  // Clean up timeout timer
  const cleanupAgentsTimeout = useCallback(() => {
    if (agentsLoadingTimeoutRef.current) {
      clearTimeout(agentsLoadingTimeoutRef.current);
      agentsLoadingTimeoutRef.current = null;
    }
  }, []);

  // Open add agent dialog
  const handleAddAgent = useCallback(() => {
    setAgentDialog({ isOpen: true, agent: null });
  }, []);

  // Open edit agent dialog
  const handleEditAgent = useCallback((agent: AgentConfig) => {
    setAgentDialog({ isOpen: true, agent });
  }, []);

  // Close agent dialog
  const handleCloseAgentDialog = useCallback(() => {
    setAgentDialog({ isOpen: false, agent: null });
  }, []);

  // Delete agent
  const handleDeleteAgent = useCallback((agent: AgentConfig) => {
    setDeleteAgentConfirm({ isOpen: true, agent });
  }, []);

  // Save agent
  const handleSaveAgent = useCallback(
    (data: { name: string; prompt: string }) => {
      const isAdding = !agentDialog.agent;

      if (isAdding) {
        // Add new agent
        const newAgent = {
          id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
          name: data.name,
          prompt: data.prompt,
        };
        sendToJava(`add_agent:${JSON.stringify(newAgent)}`);
      } else if (agentDialog.agent) {
        // Update existing agent
        const updateData = {
          id: agentDialog.agent.id,
          updates: {
            name: data.name,
            prompt: data.prompt,
          },
        };
        sendToJava(`update_agent:${JSON.stringify(updateData)}`);
      }

      setAgentDialog({ isOpen: false, agent: null });
      // Reload list after agent operation (with timeout protection)
      loadAgents();
    },
    [agentDialog.agent, loadAgents]
  );

  // Confirm agent deletion
  const confirmDeleteAgent = useCallback(() => {
    const agent = deleteAgentConfirm.agent;
    if (!agent) return;

    const data = { id: agent.id };
    sendToJava(`delete_agent:${JSON.stringify(data)}`);
    setDeleteAgentConfirm({ isOpen: false, agent: null });
    // Reload list after deletion (with timeout protection)
    loadAgents();
  }, [deleteAgentConfirm.agent, loadAgents]);

  // Cancel agent deletion
  const cancelDeleteAgent = useCallback(() => {
    setDeleteAgentConfirm({ isOpen: false, agent: null });
  }, []);

  // Handle agent operation result (used by window callback)
  const handleAgentOperationResult = useCallback(
    (result: { success: boolean; operation?: string; error?: string }) => {
      if (!result.success) {
        // Previously a failed operation reported nothing, so the tab simply
        // stopped responding to clicks with no explanation. The backend sends
        // `error` for a rejected request such as an unknown scope, and that
        // message is the only thing that tells the user what to fix.
        onError?.(t('settings.agent.operationFailedReason', { error: result.error || '' }));
        return;
      }
      const operationMessages: Record<string, string> = {
        add: t('settings.agent.addSuccess'),
        update: t('settings.agent.updateSuccess'),
        delete: t('settings.agent.deleteSuccess'),
      };
      onSuccess?.(operationMessages[result.operation || ''] || t('settings.agent.operationSuccess'));
    },
    [onSuccess, onError, t]
  );

  // Open export dialog
  const handleExportAgents = useCallback(() => {
    setExportDialog({ isOpen: true });
  }, []);

  // Close export dialog
  const handleCloseExportDialog = useCallback(() => {
    setExportDialog({ isOpen: false });
  }, []);

  // Confirm export with selected IDs
  const handleConfirmExport = useCallback((selectedIds: string[]) => {
    const exportData = {
      agentIds: selectedIds,
    };
    sendToJava(`export_agents:${JSON.stringify(exportData)}`);
    setExportDialog({ isOpen: false });
  }, []);

  // Import agents from file
  const handleImportAgentsFile = useCallback(() => {
    sendToJava('import_agents_file:');
  }, []);

  // Handle import preview result (used by window callback)
  const handleAgentImportPreviewResult = useCallback(
    (previewData: ImportPreviewResult<AgentConfig>) => {
      setImportPreviewDialog({
        isOpen: true,
        previewData,
      });
    },
    []
  );

  // Close import preview dialog
  const handleCloseImportPreview = useCallback(() => {
    setImportPreviewDialog({
      isOpen: false,
      previewData: null,
    });
  }, []);

  // Save imported agents
  const handleSaveImportedAgents = useCallback(
    (selectedIds: string[], strategy: ConflictStrategy) => {
      if (!importPreviewDialog.previewData) return;

      const selectedIdSet = new Set(selectedIds);
      const selectedAgents = importPreviewDialog.previewData.items.flatMap(item =>
        selectedIdSet.has(item.data.id) ? [item.data] : []
      );

      const importData = {
        agents: selectedAgents,
        strategy,
      };

      sendToJava(`save_imported_agents:${JSON.stringify(importData)}`);
      setImportPreviewDialog({ isOpen: false, previewData: null });
    },
    [importPreviewDialog.previewData]
  );

  // Handle import result (used by window callback)
  const handleAgentImportResult = useCallback(
    (result: { success: boolean; imported: number; updated: number; skipped: number; error?: string }) => {
      if (result.success) {
        const message = t('settings.agent.importDialog.importPartialSuccess', {
          imported: result.imported,
          updated: result.updated,
          skipped: result.skipped,
        });
        onSuccess?.(message);
      }
      // Reload agents list
      loadAgents();
    },
    [onSuccess, t, loadAgents]
  );

  return {
    // State
    agents,
    agentsLoading,
    agentDialog,
    deleteAgentConfirm,
    importPreviewDialog,
    exportDialog,
    refreshing,

    // Methods
    loadAgents,
    updateAgents,
    refreshAgentsQuietly,
    refreshAgents,
    cleanupAgentsTimeout,
    handleAddAgent,
    handleEditAgent,
    handleCloseAgentDialog,
    handleDeleteAgent,
    handleSaveAgent,
    confirmDeleteAgent,
    cancelDeleteAgent,
    handleAgentOperationResult,
    handleExportAgents,
    handleCloseExportDialog,
    handleConfirmExport,
    handleImportAgentsFile,
    handleAgentImportPreviewResult,
    handleCloseImportPreview,
    handleSaveImportedAgents,
    handleAgentImportResult,

    // Setter
    setAgentsLoading,
  };
}

export type UseAgentManagementReturn = ReturnType<typeof useAgentManagement>;
