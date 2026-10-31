import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentConfig, GetAgentsMessage } from '../../../types/agent';
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

  // Timeout timer references
  const agentsLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subagentsLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Agent list state - split into store agents (editable) and subagents (discovered, read-only)
  const [storeAgents, setStoreAgents] = useState<AgentConfig[]>([]);
  const [subagents, setSubagents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [subagentsLoading, setSubagentsLoading] = useState(false);

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

  // Spins on the refresh button while an explicit re-read is in flight.
  const [refreshing, setRefreshing] = useState(false);

  // Combined agents for backward compatibility (store agents + subagents)
  // Store agents come first so they appear at the top
  const agents = [...storeAgents, ...subagents];

  // Load store agents (editable agents for chat-bar compatibility)
  const loadStoreAgents = useCallback((retryCount = 0) => {
    const MAX_RETRIES = 2;
    const TIMEOUT = 3000;

    setAgentsLoading(true);
    // Only request store scope - chat bar and store management
    const request: GetAgentsMessage = { scopes: ['store'] };
    sendToJava(`get_agents:${JSON.stringify(request)}`);

    const timeoutId = setTimeout(() => {
      if (retryCount < MAX_RETRIES) {
        loadStoreAgents(retryCount + 1);
      } else {
        setAgentsLoading(false);
        setStoreAgents([]);
      }
    }, TIMEOUT);

    agentsLoadingTimeoutRef.current = timeoutId;
  }, []);

  // Load discovered subagents (read-only, for Settings tab display)
  const loadSubagents = useCallback((retryCount = 0) => {
    const MAX_RETRIES = 2;
    const TIMEOUT = 3000;

    setSubagentsLoading(true);
    // Request global and local scopes for discovered agents
    const request: GetAgentsMessage = { scopes: ['global', 'local'] };
    sendToJava(`get_subagents:${JSON.stringify(request)}`);

    const timeoutId = setTimeout(() => {
      if (retryCount < MAX_RETRIES) {
        loadSubagents(retryCount + 1);
      } else {
        setSubagentsLoading(false);
        setSubagents([]);
      }
    }, TIMEOUT);

    subagentsLoadingTimeoutRef.current = timeoutId;
  }, []);

  // Load both store agents and subagents
  const loadAgents = useCallback(() => {
    loadStoreAgents();
    loadSubagents();
  }, [loadStoreAgents, loadSubagents]);

  // Set up window callbacks for agents and subagents
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleUpdateAgents = (json: string) => {
      try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) {
          setStoreAgents(parsed);
        }
        setAgentsLoading(false);
        if (agentsLoadingTimeoutRef.current) {
          clearTimeout(agentsLoadingTimeoutRef.current);
          agentsLoadingTimeoutRef.current = null;
        }
      } catch (error) {
        setAgentsLoading(false);
        console.error('[useAgentManagement] Failed to parse agents:', error);
      }
    };

    const handleUpdateSubagents = (json: string) => {
      try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) {
          setSubagents(parsed);
        }
        setSubagentsLoading(false);
        if (subagentsLoadingTimeoutRef.current) {
          clearTimeout(subagentsLoadingTimeoutRef.current);
          subagentsLoadingTimeoutRef.current = null;
        }
      } catch (error) {
        setSubagentsLoading(false);
        console.error('[useAgentManagement] Failed to parse subagents:', error);
      }
    };

    const originalUpdateAgents = window.updateAgents;
    window.updateAgents = (json: string) => {
      handleUpdateAgents(json);
      originalUpdateAgents?.(json);
    };

    const originalUpdateSubagents = window.updateSubagents;
    window.updateSubagents = (json: string) => {
      handleUpdateSubagents(json);
      originalUpdateSubagents?.(json);
    };

    return () => {
      window.updateAgents = originalUpdateAgents;
      window.updateSubagents = originalUpdateSubagents;
    };
  }, []);

  /**
   * Re-read the list without flashing the loading state.
   */
  const refreshAgentsQuietly = useCallback(() => {
    if (agentsLoadingTimeoutRef.current) {
      clearTimeout(agentsLoadingTimeoutRef.current);
    }
    if (subagentsLoadingTimeoutRef.current) {
      clearTimeout(subagentsLoadingTimeoutRef.current);
    }
    const storeRequest: GetAgentsMessage = { scopes: ['store'] };
    sendToJava(`get_agents:${JSON.stringify(storeRequest)}`);
    const subRequest: GetAgentsMessage = { scopes: ['global', 'local'] };
    sendToJava(`get_subagents:${JSON.stringify(subRequest)}`);

    agentsLoadingTimeoutRef.current = setTimeout(() => {
      agentsLoadingTimeoutRef.current = null;
      setAgentsLoading(false);
      setRefreshing(false);
    }, REFRESH_TIMEOUT);

    subagentsLoadingTimeoutRef.current = setTimeout(() => {
      subagentsLoadingTimeoutRef.current = null;
      setSubagentsLoading(false);
    }, REFRESH_TIMEOUT);
  }, []);

  /**
   * Re-read the list at the user's request.
   */
  const refreshAgents = useCallback(() => {
    setRefreshing(true);
    refreshAgentsQuietly();
  }, [refreshAgentsQuietly]);

  // Update store agents (used by window callback)
  const updateAgents = useCallback((agentsList: AgentConfig[]) => {
    setRefreshing(false);
    if (agentsLoadingTimeoutRef.current) {
      clearTimeout(agentsLoadingTimeoutRef.current);
      agentsLoadingTimeoutRef.current = null;
    }
    setStoreAgents(agentsList);
    setAgentsLoading(false);
  }, []);

  // Update subagents (used by window callback)
  const updateSubagents = useCallback((agentsList: AgentConfig[]) => {
    if (subagentsLoadingTimeoutRef.current) {
      clearTimeout(subagentsLoadingTimeoutRef.current);
      subagentsLoadingTimeoutRef.current = null;
    }
    setSubagents(agentsList);
    setSubagentsLoading(false);
  }, []);

  // Clean up timeout timers
  const cleanupAgentsTimeout = useCallback(() => {
    if (agentsLoadingTimeoutRef.current) {
      clearTimeout(agentsLoadingTimeoutRef.current);
      agentsLoadingTimeoutRef.current = null;
    }
    if (subagentsLoadingTimeoutRef.current) {
      clearTimeout(subagentsLoadingTimeoutRef.current);
      subagentsLoadingTimeoutRef.current = null;
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
    agents, // combined: storeAgents + subagents (for backward compatibility)
    storeAgents,
    subagents,
    agentsLoading, // true when either storeAgents or subagents is loading
    subagentsLoading,
    agentDialog,
    deleteAgentConfirm,
    importPreviewDialog,
    exportDialog,
    refreshing,

    // Methods
    loadAgents,
    loadStoreAgents,
    loadSubagents,
    updateAgents,
    updateSubagents,
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
