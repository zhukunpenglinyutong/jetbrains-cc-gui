import { useState, useCallback, useRef } from 'react';
import type { AgentConfig } from '../../../types/agent';

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

export interface UseAgentManagementOptions {
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

export function useAgentManagement(options: UseAgentManagementOptions = {}) {
  const { onSuccess } = options;

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

  // Load agent list (with retry mechanism)
  const loadAgents = useCallback((retryCount = 0) => {
    const MAX_RETRIES = 2;
    const TIMEOUT = 3000; // 3-second timeout

    setAgentsLoading(true);
    sendToJava('get_agents:');

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

  // Update agent list (used by window callback)
  const updateAgents = useCallback((agentsList: AgentConfig[]) => {
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
      if (result.success) {
        const operationMessages: Record<string, string> = {
          add: '智能体已添加',
          update: '智能体已更新',
          delete: '智能体已删除',
        };
        onSuccess?.(operationMessages[result.operation || ''] || '操作成功');
      }
    },
    [onSuccess]
  );

  return {
    // State
    agents,
    agentsLoading,
    agentDialog,
    deleteAgentConfirm,

    // Methods
    loadAgents,
    updateAgents,
    cleanupAgentsTimeout,
    handleAddAgent,
    handleEditAgent,
    handleCloseAgentDialog,
    handleDeleteAgent,
    handleSaveAgent,
    confirmDeleteAgent,
    cancelDeleteAgent,
    handleAgentOperationResult,

    // Setter
    setAgentsLoading,
  };
}

export type UseAgentManagementReturn = ReturnType<typeof useAgentManagement>;
