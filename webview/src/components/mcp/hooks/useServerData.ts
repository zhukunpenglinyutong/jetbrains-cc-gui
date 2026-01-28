/**
 * 服务器数据加载和初始化 Hook
 * 管理服务器列表、状态和缓存的加载
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { McpServer, McpServerStatusInfo, ServerToolsState, RefreshLog, CacheKeys } from '../types';
import { sendToJava } from '../../../utils/bridge';
import { readCache, readToolsCache } from '../utils';

export interface UseServerDataOptions {
  isCodexMode: boolean;
  messagePrefix: string;
  cacheKeys: CacheKeys;
  t: (key: string, options?: Record<string, unknown>) => string;
  onLog: (message: string, type: RefreshLog['type'], details?: string, serverName?: string, requestInfo?: string, errorReason?: string) => void;
}

export interface UseServerDataReturn {
  // 状态
  servers: McpServer[];
  serverStatus: Map<string, McpServerStatusInfo>;
  loading: boolean;
  statusLoading: boolean;
  serverTools: ServerToolsState;
  expandedServers: Set<string>;

  // 状态更新函数
  setServers: React.Dispatch<React.SetStateAction<McpServer[]>>;
  setServerStatus: React.Dispatch<React.SetStateAction<Map<string, McpServerStatusInfo>>>;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  setExpandedServers: React.Dispatch<React.SetStateAction<Set<string>>>;

  // 数据加载函数
  loadServers: () => void;
  loadServerStatus: () => void;
  loadServerTools: (server: McpServer, forceRefresh?: boolean) => void;
}

/**
 * 服务器数据加载和初始化 Hook
 */
export function useServerData({
  isCodexMode,
  messagePrefix,
  cacheKeys,
  t,
  onLog
}: UseServerDataOptions): UseServerDataReturn {
  // 状态
  const [servers, setServers] = useState<McpServer[]>([]);
  const [serverStatus, setServerStatus] = useState<Map<string, McpServerStatusInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [serverTools, setServerTools] = useState<ServerToolsState>({});
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  // Refs
  const refreshTimersRef = useRef<number[]>([]);

  // 加载服务器列表
  const loadServers = useCallback(() => {
    setLoading(true);
    onLog(
      t('mcp.logs.loadingServers'),
      'info',
      undefined,
      undefined,
      `get_${messagePrefix}mcp_servers request to backend`
    );
    sendToJava(`get_${messagePrefix}mcp_servers`, {});
  }, [messagePrefix, t, onLog]);

  // 加载服务器状态
  const loadServerStatus = useCallback(() => {
    setStatusLoading(true);
    onLog(
      t('mcp.logs.refreshingStatus'),
      'info',
      undefined,
      undefined,
      `get_${messagePrefix}mcp_server_status request to backend`,
      `Querying MCP server connection status via ${isCodexMode ? 'Codex' : 'Claude'} SDK`
    );
    sendToJava(`get_${messagePrefix}mcp_server_status`, {});
  }, [messagePrefix, isCodexMode, t, onLog]);

  // 加载服务器工具列表
  const loadServerTools = useCallback((server: McpServer, forceRefresh = false) => {
    // Codex 模式不支持工具列表
    if (isCodexMode) {
      setServerTools(prev => ({
        ...prev,
        [server.id]: {
          tools: [],
          loading: false,
          error: 'Tool listing not supported in Codex mode'
        }
      }));
      return;
    }

    // 检查缓存（除非强制刷新）
    if (!forceRefresh) {
      const cachedTools = readToolsCache(server.id, cacheKeys);
      if (cachedTools && cachedTools.length > 0) {
        setServerTools(prev => ({
          ...prev,
          [server.id]: {
            tools: cachedTools,
            loading: false,
            error: undefined
          }
        }));
        onLog(
          t('mcp.logs.loadedToolsFromCache', { name: server.name || server.id, count: cachedTools.length }),
          'info',
          undefined,
          server.name || server.id
        );
        return;
      }
    }

    // 设置加载状态
    setServerTools(prev => ({
      ...prev,
      [server.id]: {
        tools: [],
        loading: true,
        error: undefined
      }
    }));

    onLog(
      forceRefresh
        ? t('mcp.logs.forceRefreshingTools', { name: server.name || server.id })
        : t('mcp.logs.loadingTools', { name: server.name || server.id }),
      'info',
      undefined,
      server.name || server.id,
      `get_mcp_server_tools request to backend`
    );

    sendToJava('get_mcp_server_tools', { serverId: server.id, forceRefresh });
  }, [isCodexMode, cacheKeys, t, onLog]);

  // 初始化和数据加载
  useEffect(() => {
    const clearRefreshTimers = () => {
      refreshTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      refreshTimersRef.current = [];
    };

    // 从缓存加载数据
    const loadFromCache = (): boolean => {
      const cachedServers = readCache<McpServer[]>(cacheKeys.SERVERS, cacheKeys);
      const hasValidCache = !!cachedServers && cachedServers.length > 0;

      if (hasValidCache) {
        setServers(cachedServers);
        setLoading(false);
        const cacheAge = Date.now() - (JSON.parse(localStorage.getItem(cacheKeys.SERVERS) || '{}').timestamp || 0);
        if (cacheAge < 60000) {
          onLog(t('mcp.logs.fastLoadCache', { count: cachedServers.length, seconds: Math.round(cacheAge/1000) }), 'info');
        }
      }

      if (!isCodexMode) {
        const cachedStatus = readCache<McpServerStatusInfo[]>(cacheKeys.STATUS, cacheKeys);
        if (cachedStatus && cachedStatus.length > 0) {
          const statusMap = new Map<string, McpServerStatusInfo>();
          cachedStatus.forEach((status) => {
            statusMap.set(status.name, status);
          });
          setServerStatus(statusMap);
          setStatusLoading(false);
        }
      }

      // 恢复上次展开的服务器
      if (hasValidCache) {
        try {
          const lastServerId = localStorage.getItem(cacheKeys.LAST_SERVER_ID);
          if (lastServerId) {
            const serverExists = cachedServers.some(s => s.id === lastServerId);
            if (serverExists) {
              setExpandedServers(new Set([lastServerId]));
              const cachedTools = readToolsCache(lastServerId, cacheKeys);
              if (cachedTools && cachedTools.length > 0) {
                setServerTools(prev => ({
                  ...prev,
                  [lastServerId]: {
                    tools: cachedTools,
                    loading: false,
                    error: undefined
                  }
                }));
                onLog(t('mcp.logs.loadedToolsFromCacheSimple', { count: cachedTools.length }), 'info', undefined, lastServerId);
              }
            }
          }
        } catch (e) {
          console.warn('[MCP] Failed to restore last expanded server:', e);
        }
      }

      return hasValidCache;
    };

    // 先尝试从缓存加载数据
    const hasCache = loadFromCache();

    if (hasCache) {
      onLog(t('mcp.logs.usingCacheStrategy'), 'info');
    } else {
      onLog(t('mcp.logs.firstLoad'), 'info');
      loadServers();
      loadServerStatus();
    }

    return () => {
      clearRefreshTimers();
    };
  }, [cacheKeys, isCodexMode, loadServers, loadServerStatus, t, onLog]);

  // 注册服务器列表更新回调
  useEffect(() => {
    const handleServerListUpdate = (jsonStr: string) => {
      try {
        const serverList: McpServer[] = JSON.parse(jsonStr);
        setServers(serverList);
        setLoading(false);
        onLog(t('mcp.logs.loadedServersSuccess', { count: serverList.length }), 'success');
      } catch (error) {
        console.error('[McpSettings] Failed to parse servers:', error);
        setLoading(false);
        onLog(t('mcp.logs.loadedServersFailed', { error: String(error) }), 'error');
      }
    };

    const handleServerStatusUpdate = (jsonStr: string) => {
      try {
        const statusList: McpServerStatusInfo[] = JSON.parse(jsonStr);
        const statusMap = new Map<string, McpServerStatusInfo>();
        statusList.forEach((status) => {
          statusMap.set(status.name, status);
        });
        setServerStatus(statusMap);
        setStatusLoading(false);

        const statusCount = {
          connected: statusList.filter(s => s.status === 'connected').length,
          failed: statusList.filter(s => s.status === 'failed').length,
          pending: statusList.filter(s => s.status === 'pending').length,
          needsAuth: statusList.filter(s => s.status === 'needs-auth').length
        };

        onLog(
          t('mcp.logs.statusUpdateComplete', {
            total: statusList.length,
            connected: statusCount.connected,
            failed: statusCount.failed,
            pending: statusCount.pending,
            needsAuth: statusCount.needsAuth
          }),
          statusCount.failed > 0 ? 'warning' : 'success'
        );
      } catch (error) {
        console.error('[McpSettings] Failed to parse server status:', error);
        setStatusLoading(false);
        onLog(t('mcp.logs.loadedStatusFailed', { error: String(error) }), 'error');
      }
    };

    // 注册回调
    if (isCodexMode) {
      window.updateCodexMcpServers = handleServerListUpdate;
      window.updateCodexMcpServerStatus = handleServerStatusUpdate;
    } else {
      window.updateMcpServers = handleServerListUpdate;
      window.updateMcpServerStatus = handleServerStatusUpdate;
    }

    return () => {
      if (isCodexMode) {
        window.updateCodexMcpServers = undefined;
        window.updateCodexMcpServerStatus = undefined;
      } else {
        window.updateMcpServers = undefined;
        window.updateMcpServerStatus = undefined;
      }
    };
  }, [isCodexMode, t, onLog]);

  return {
    // 状态
    servers,
    serverStatus,
    loading,
    statusLoading,
    serverTools,
    expandedServers,

    // 状态更新函数
    setServers,
    setServerStatus,
    setServerTools,
    setExpandedServers,

    // 数据加载函数
    loadServers,
    loadServerStatus,
    loadServerTools,
  };
}
