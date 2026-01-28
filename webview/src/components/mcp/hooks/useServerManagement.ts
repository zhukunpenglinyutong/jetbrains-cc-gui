/**
 * 服务器管理操作 Hook
 * 处理服务器的刷新、切换等操作
 */

import { useState, useCallback } from 'react';
import type { McpServer, ServerToolsState, ServerRefreshState, RefreshLog, CacheKeys } from '../types';
import { sendToJava } from '../../../utils/bridge';
import { clearToolsCache, clearAllToolsCache } from '../utils';
import type { ToastMessage } from '../../Toast';

export interface UseServerManagementOptions {
  isCodexMode: boolean;
  messagePrefix: string;
  cacheKeys: CacheKeys;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  loadServers: () => void;
  loadServerStatus: () => void;
  loadServerTools: (server: McpServer, forceRefresh?: boolean) => void;
  onLog: (message: string, type: RefreshLog['type'], details?: string, serverName?: string, requestInfo?: string, errorReason?: string) => void;
  onToast: (message: string, type: ToastMessage['type']) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export interface UseServerManagementReturn {
  serverRefreshStates: ServerRefreshState;
  handleRefresh: () => void;
  handleRefreshSingleServer: (server: McpServer, forceRefreshTools?: boolean) => void;
  handleToggleServer: (server: McpServer, enabled: boolean) => void;
}

/**
 * 服务器管理操作 Hook
 */
export function useServerManagement({
  isCodexMode,
  messagePrefix,
  cacheKeys,
  setServerTools,
  loadServers,
  loadServerStatus,
  loadServerTools,
  onLog,
  onToast,
  t,
}: UseServerManagementOptions): UseServerManagementReturn {
  // 单个服务器刷新状态
  const [serverRefreshStates, setServerRefreshStates] = useState<ServerRefreshState>({});

  // 设置单个服务器刷新状态
  const setServerRefreshing = useCallback((serverId: string, isRefreshing: boolean, step: string = '') => {
    setServerRefreshStates(prev => ({
      ...prev,
      [serverId]: { isRefreshing, step }
    }));
  }, []);

  // 刷新所有服务器
  const handleRefresh = useCallback(() => {
    onLog(t('mcp.logs.refreshingAll'), 'info');
    // 清除所有工具缓存
    clearAllToolsCache(cacheKeys);
    // 清空当前工具状态
    setServerTools({});
    loadServers();
    loadServerStatus();
  }, [cacheKeys, setServerTools, loadServers, loadServerStatus, t, onLog]);

  // 刷新单个服务器
  const handleRefreshSingleServer = useCallback((server: McpServer, forceRefreshTools: boolean = false) => {
    const serverName = server.name || server.id;
    setServerRefreshing(server.id, true, t('mcp.logs.startRefresh'));

    if (forceRefreshTools) {
      // 强制刷新工具列表
      clearToolsCache(server.id, cacheKeys);
      setServerTools(prev => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
      onLog(t('mcp.logs.forceRefreshingToolsServer', { name: serverName }), 'info', undefined, serverName);
      loadServerTools(server, true);
    } else {
      onLog(t('mcp.logs.startRefreshServer', { name: serverName }), 'info', undefined, serverName);
    }

    // 模拟刷新过程（因为SDK不支持单个服务器刷新）
    setTimeout(() => {
      setServerRefreshing(server.id, true, t('mcp.logs.checkingConnection'));
      onLog(t('mcp.logs.checkingConnectionServer', { name: serverName }), 'info', undefined, serverName);
    }, 300);

    setTimeout(() => {
      // 刷新所有服务器状态来更新
      loadServerStatus();
      setServerRefreshing(server.id, false, '');
      onLog(t('mcp.logs.refreshComplete', { name: serverName }), 'success', undefined, serverName);
    }, 1500);
  }, [cacheKeys, setServerTools, loadServerStatus, loadServerTools, t, onLog, setServerRefreshing]);

  // 切换服务器启用状态
  const handleToggleServer = useCallback((server: McpServer, enabled: boolean) => {
    // Set apps based on current provider mode
    const updatedServer: McpServer = {
      ...server,
      enabled,
      apps: {
        claude: isCodexMode ? (server.apps?.claude ?? false) : enabled,
        codex: isCodexMode ? enabled : (server.apps?.codex ?? false),
        gemini: server.apps?.gemini ?? false,
      }
    };

    sendToJava(`toggle_${messagePrefix}mcp_server`, updatedServer);

    // 显示Toast提示
    onToast(
      enabled
        ? `${t('mcp.enabled')} ${server.name || server.id}`
        : `${t('mcp.disabled')} ${server.name || server.id}`,
      'success'
    );

    loadServers();
    loadServerStatus();
  }, [isCodexMode, messagePrefix, onToast, t, loadServers, loadServerStatus]);

  return {
    serverRefreshStates,
    handleRefresh,
    handleRefreshSingleServer,
    handleToggleServer,
  };
}
