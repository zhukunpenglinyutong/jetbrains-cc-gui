import { useState, useCallback, useRef } from 'react';
import type { AgentConfig } from '../../../types/agent';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // sendToJava 不可用时静默处理，避免生产环境日志污染
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

  // 超时定时器引用（使用 useRef 避免全局变量污染）
  const agentsLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Agent 列表状态
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  // Agent 弹窗状态
  const [agentDialog, setAgentDialog] = useState<AgentDialogState>({
    isOpen: false,
    agent: null,
  });

  // Agent 删除确认状态
  const [deleteAgentConfirm, setDeleteAgentConfirm] = useState<DeleteAgentConfirmState>({
    isOpen: false,
    agent: null,
  });

  // 加载 Agent 列表（带重试机制）
  const loadAgents = useCallback((retryCount = 0) => {
    const MAX_RETRIES = 2;
    const TIMEOUT = 3000; // 3秒超时

    setAgentsLoading(true);
    sendToJava('get_agents:');

    // 设置超时定时器
    const timeoutId = setTimeout(() => {
      if (retryCount < MAX_RETRIES) {
        // 重试
        loadAgents(retryCount + 1);
      } else {
        // 达到最大重试次数，停止加载
        setAgentsLoading(false);
        setAgents([]); // 显示空列表，允许用户继续使用
      }
    }, TIMEOUT);

    // 使用 ref 存储超时 ID
    agentsLoadingTimeoutRef.current = timeoutId;
  }, []);

  // 更新 Agent 列表（供 window callback 使用）
  const updateAgents = useCallback((agentsList: AgentConfig[]) => {
    // 清除超时定时器
    if (agentsLoadingTimeoutRef.current) {
      clearTimeout(agentsLoadingTimeoutRef.current);
      agentsLoadingTimeoutRef.current = null;
    }

    setAgents(agentsList);
    setAgentsLoading(false);
  }, []);

  // 清理超时定时器
  const cleanupAgentsTimeout = useCallback(() => {
    if (agentsLoadingTimeoutRef.current) {
      clearTimeout(agentsLoadingTimeoutRef.current);
      agentsLoadingTimeoutRef.current = null;
    }
  }, []);

  // 打开添加 Agent 弹窗
  const handleAddAgent = useCallback(() => {
    setAgentDialog({ isOpen: true, agent: null });
  }, []);

  // 打开编辑 Agent 弹窗
  const handleEditAgent = useCallback((agent: AgentConfig) => {
    setAgentDialog({ isOpen: true, agent });
  }, []);

  // 关闭 Agent 弹窗
  const handleCloseAgentDialog = useCallback(() => {
    setAgentDialog({ isOpen: false, agent: null });
  }, []);

  // 删除 Agent
  const handleDeleteAgent = useCallback((agent: AgentConfig) => {
    setDeleteAgentConfirm({ isOpen: true, agent });
  }, []);

  // 保存 Agent
  const handleSaveAgent = useCallback(
    (data: { name: string; prompt: string }) => {
      const isAdding = !agentDialog.agent;

      if (isAdding) {
        // 添加新智能体
        const newAgent = {
          id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
          name: data.name,
          prompt: data.prompt,
        };
        sendToJava(`add_agent:${JSON.stringify(newAgent)}`);
      } else if (agentDialog.agent) {
        // 更新现有智能体
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
      // 智能体操作后重新加载列表（包含超时保护）
      loadAgents();
    },
    [agentDialog.agent, loadAgents]
  );

  // 确认删除 Agent
  const confirmDeleteAgent = useCallback(() => {
    const agent = deleteAgentConfirm.agent;
    if (!agent) return;

    const data = { id: agent.id };
    sendToJava(`delete_agent:${JSON.stringify(data)}`);
    setDeleteAgentConfirm({ isOpen: false, agent: null });
    // 删除后重新加载列表（包含超时保护）
    loadAgents();
  }, [deleteAgentConfirm.agent, loadAgents]);

  // 取消删除 Agent
  const cancelDeleteAgent = useCallback(() => {
    setDeleteAgentConfirm({ isOpen: false, agent: null });
  }, []);

  // 处理 Agent 操作结果（供 window callback 使用）
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
    // 状态
    agents,
    agentsLoading,
    agentDialog,
    deleteAgentConfirm,

    // 方法
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
