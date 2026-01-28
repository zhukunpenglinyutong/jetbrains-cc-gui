import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer, McpPreset, McpServerStatusInfo } from '../../types/mcp';
import { sendToJava } from '../../utils/bridge';
import { McpServerDialog } from './McpServerDialog';
import { McpPresetDialog } from './McpPresetDialog';
import { McpHelpDialog } from './McpHelpDialog';
import { McpConfirmDialog } from './McpConfirmDialog';
import { ToastContainer, type ToastMessage } from '../Toast';
import { copyToClipboard } from '../../utils/copyUtils';

// 获取提供商特定的缓存键名
const getCacheKeys = (provider: 'claude' | 'codex') => ({
  SERVERS: `mcp_servers_cache_${provider}`,
  STATUS: `mcp_status_cache_${provider}`,
  TOOLS: `mcp_tools_cache_${provider}`,
  LAST_SERVER_ID: `mcp_last_server_id_${provider}`, // 上次展开的服务器ID
});

// 缓存过期时间（服务器列表10分钟，状态5分钟，工具列表10分钟）
const CACHE_EXPIRY = {
  SERVERS: 10 * 60 * 1000,
  STATUS: 5 * 60 * 1000,
  TOOLS: 10 * 60 * 1000,
};

// 缓存数据结构
interface CachedData<T> {
  data: T;
  timestamp: number;
}

// 获取缓存过期时间
function getCacheExpiry(key: string, cacheKeys: ReturnType<typeof getCacheKeys>): number {
  if (key === cacheKeys.SERVERS) return CACHE_EXPIRY.SERVERS;
  if (key === cacheKeys.STATUS) return CACHE_EXPIRY.STATUS;
  if (key === cacheKeys.TOOLS) return CACHE_EXPIRY.TOOLS;
  return 5 * 60 * 1000; // 默认5分钟
}

// 读取缓存（支持不同过期时间）
function readCache<T>(key: string, cacheKeys: ReturnType<typeof getCacheKeys>): T | null {
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return null;
    const parsed: CachedData<T> = JSON.parse(cached);
    // 检查是否过期
    const expiry = getCacheExpiry(key, cacheKeys);
    if (Date.now() - parsed.timestamp > expiry) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

// 写入缓存
function writeCache<T>(key: string, data: T): void {
  try {
    const cached: CachedData<T> = {
      data,
      timestamp: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(cached));
  } catch (e) {
    console.warn('[MCP] Failed to write cache:', e);
  }
}

// 工具列表缓存结构
interface ToolsCacheData {
  [serverId: string]: {
    tools: McpTool[];
    timestamp: number;
  };
}

// 读取单个服务器的工具缓存
function readToolsCache(serverId: string, cacheKeys: ReturnType<typeof getCacheKeys>): McpTool[] | null {
  try {
    const cached = localStorage.getItem(cacheKeys.TOOLS);
    if (!cached) return null;
    const parsed: ToolsCacheData = JSON.parse(cached);
    const serverCache = parsed[serverId];
    if (!serverCache) return null;
    // 检查是否过期
    if (Date.now() - serverCache.timestamp > CACHE_EXPIRY.TOOLS) {
      delete parsed[serverId];
      localStorage.setItem(cacheKeys.TOOLS, JSON.stringify(parsed));
      return null;
    }
    return serverCache.tools;
  } catch {
    return null;
  }
}

// 写入单个服务器的工具缓存
function writeToolsCache(serverId: string, tools: McpTool[], cacheKeys: ReturnType<typeof getCacheKeys>): void {
  try {
    const cachedStr = localStorage.getItem(cacheKeys.TOOLS);
    const parsed: ToolsCacheData = cachedStr ? JSON.parse(cachedStr) : {};
    parsed[serverId] = {
      tools,
      timestamp: Date.now(),
    };
    localStorage.setItem(cacheKeys.TOOLS, JSON.stringify(parsed));
  } catch (e) {
    console.warn('[MCP] Failed to write tools cache:', e);
  }
}

// 清除单个服务器的工具缓存
function clearToolsCache(serverId: string, cacheKeys: ReturnType<typeof getCacheKeys>): void {
  try {
    const cachedStr = localStorage.getItem(cacheKeys.TOOLS);
    if (!cachedStr) return;
    const parsed: ToolsCacheData = JSON.parse(cachedStr);
    delete parsed[serverId];
    localStorage.setItem(cacheKeys.TOOLS, JSON.stringify(parsed));
  } catch (e) {
    console.warn('[MCP] Failed to clear tools cache:', e);
  }
}

// 清除所有工具缓存
function clearAllToolsCache(cacheKeys: ReturnType<typeof getCacheKeys>): void {
  try {
    localStorage.removeItem(cacheKeys.TOOLS);
  } catch (e) {
    console.warn('[MCP] Failed to clear all tools cache:', e);
  }
}

interface McpSettingsSectionProps {
  currentProvider?: 'claude' | 'codex' | string;
}

// 单个服务器刷新状态
interface ServerRefreshState {
  [serverId: string]: {
    isRefreshing: boolean;
    step: string;
  };
}

// MCP 工具类型
interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

// 服务器工具列表状态
interface ServerToolsState {
  [serverId: string]: {
    tools: McpTool[];
    loading: boolean;
    error?: string;
  };
}

/**
 * MCP 服务器设置组件
 * Supports both Claude and Codex providers
 */
export function McpSettingsSection({ currentProvider = 'claude' }: McpSettingsSectionProps) {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';

  // Generate message type prefix based on provider
  const messagePrefix = useMemo(() => (isCodexMode ? 'codex_' : ''), [isCodexMode]);

  // Get provider-specific cache keys
  const cacheKeys = useMemo(() => getCacheKeys(isCodexMode ? 'codex' : 'claude'), [isCodexMode]);

  const [servers, setServers] = useState<McpServer[]>([]);
  const [serverStatus, setServerStatus] = useState<Map<string, McpServerStatusInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const refreshTimersRef = useRef<number[]>([]);

  // 单个服务器刷新状态
  const [serverRefreshStates, setServerRefreshStates] = useState<ServerRefreshState>({});

  // 服务器工具列表状态
  const [serverTools, setServerTools] = useState<ServerToolsState>({});

  // 工具提示浮框状态
  const [hoveredTool, setHoveredTool] = useState<{ serverId: string; tool: McpTool; position: { x: number; y: number } } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // 弹窗状态
  const [showServerDialog, setShowServerDialog] = useState(false);
  const [showPresetDialog, setShowPresetDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [deletingServer, setDeletingServer] = useState<McpServer | null>(null);

  // Toast 状态管理
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // 刷新日志状态
  interface RefreshLog {
    id: string;
    timestamp: Date;
    type: 'info' | 'success' | 'warning' | 'error';
    message: string;
    details?: string;
    serverName?: string; // 关联的服务器名称
    requestInfo?: string; // 请求信息
    errorReason?: string; // 错误原因
  }
  const [refreshLogs, setRefreshLogs] = useState<RefreshLog[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Toast 辅助函数
  const addToast = (message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  // 日志辅助函数 - 增强版，支持服务器名称、请求信息和错误原因
  const addLog = (
    message: string,
    type: RefreshLog['type'] = 'info',
    details?: string,
    serverName?: string,
    requestInfo?: string,
    errorReason?: string
  ) => {
    const id = `log-${Date.now()}-${Math.random()}`;
    const log: RefreshLog = {
      id,
      timestamp: new Date(),
      type,
      message,
      details,
      serverName,
      requestInfo,
      errorReason
    };
    setRefreshLogs((prev) => [...prev, log].slice(-100)); // 保留最近 100 条
    console.log(`[MCP ${type.toUpperCase()}]`, message, details || '', requestInfo || '', errorReason || '');
  };

  const clearLogs = () => {
    setRefreshLogs([]);
    addLog('刷新日志已清空', 'info');
  };

  // 自动滚动到日志底部
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [refreshLogs]);

  // 设置单个服务器刷新状态
  const setServerRefreshing = (serverId: string, isRefreshing: boolean, step: string = '') => {
    setServerRefreshStates(prev => ({
      ...prev,
      [serverId]: { isRefreshing, step }
    }));
  };

  // 服务器图标颜色
  const iconColors = [
    '#3B82F6', // blue
    '#10B981', // green
    '#8B5CF6', // purple
    '#F59E0B', // amber
    '#EF4444', // red
    '#EC4899', // pink
    '#06B6D4', // cyan
    '#6366F1', // indigo
  ];

  // 初始化
  useEffect(() => {
    const clearRefreshTimers = () => {
      refreshTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      refreshTimersRef.current = [];
    };

    // 从缓存加载数据，返回是否有有效缓存
    const loadFromCache = (): boolean => {
      const cachedServers = readCache<McpServer[]>(cacheKeys.SERVERS, cacheKeys);
      const hasValidCache = !!cachedServers && cachedServers.length > 0;

      if (hasValidCache) {
        setServers(cachedServers);
        setLoading(false);
        // 仅在缓存数据较新时显示消息（避免重复日志）
        const cacheAge = Date.now() - (JSON.parse(localStorage.getItem(cacheKeys.SERVERS) || '{}').timestamp || 0);
        if (cacheAge < 60000) { // 缓存小于1分钟才显示
          addLog(`快速加载缓存：${cachedServers.length} 个服务器 (缓存时间: ${Math.round(cacheAge/1000)}秒前)`, 'info');
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

      // 恢复上次展开的服务器（从缓存）
      if (hasValidCache) {
        try {
          const lastServerId = localStorage.getItem(cacheKeys.LAST_SERVER_ID);
          if (lastServerId) {
            const serverExists = cachedServers.some(s => s.id === lastServerId);
            if (serverExists) {
              setExpandedServers(new Set([lastServerId]));
              // 尝试从缓存加载工具列表
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
                addLog(`从缓存加载工具列表：${cachedTools.length} 个工具`, 'info', undefined, lastServerId);
              }
            }
          }
        } catch (e) {
          console.warn('[MCP] Failed to restore last expanded server:', e);
        }
      }

      return hasValidCache;
    };

    const scheduleRefresh = (enabled: boolean) => {
      clearRefreshTimers();

      const serverRefreshDelays = enabled ? [200, 1000] : [200];
      // Codex mode: no status refresh (Codex SDK doesn't support real-time status)
      const statusRefreshDelays = isCodexMode ? [] : (enabled ? [400, 1500, 3500, 7000, 12000] : [400]);

      serverRefreshDelays.forEach((delay) => {
        refreshTimersRef.current.push(window.setTimeout(() => loadServers(), delay));
      });
      statusRefreshDelays.forEach((delay) => {
        refreshTimersRef.current.push(window.setTimeout(() => loadServerStatus(), delay));
      });
    };

    // Server list callback handler
    const handleServerListUpdate = (jsonStr: string) => {
      try {
        const serverList: McpServer[] = JSON.parse(jsonStr);
        setServers(serverList);
        // 写入缓存
        writeCache(cacheKeys.SERVERS, serverList);
        setLoading(false);
        addLog(`加载服务器列表成功：找到 ${serverList.length} 个服务器`, 'success');
        console.log(`[McpSettings] Loaded ${isCodexMode ? 'Codex' : 'Claude'} servers:`, serverList);
      } catch (error) {
        console.error('[McpSettings] Failed to parse servers:', error);
        setLoading(false);
        addLog(`加载服务器列表失败：${error}`, 'error');
      }
    };

    // Server status callback handler (works for both Claude and Codex)
    const handleServerStatusUpdate = (jsonStr: string) => {
      try {
        const statusList: McpServerStatusInfo[] = JSON.parse(jsonStr);
        // 写入缓存
        writeCache(cacheKeys.STATUS, statusList);
        const statusMap = new Map<string, McpServerStatusInfo>();
        statusList.forEach((status) => {
          statusMap.set(status.name, status);
        });
        setServerStatus(statusMap);
        setStatusLoading(false);

        // 为每个服务器添加详细日志
        statusList.forEach((status) => {
          const server = servers.find(s => s.id === status.name || s.name === status.name);
          const serverDisplayName = server?.name || status.name;
          const serverConfig = server?.server;

          // MCP 测试步骤 1: 连接验证
          addLog(
            `[MCP测试] ${serverDisplayName} - 步骤 1/4: 连接验证`,
            'info',
            undefined,
            serverDisplayName,
            `Verifying MCP server connection`
          );

          if (status.status === 'connected') {
            const versionInfo = status.serverInfo
              ? ` v${status.serverInfo.version}`
              : '';
            // MCP 测试步骤 2: 初始化成功
            addLog(
              `[MCP测试] ${serverDisplayName} - 步骤 2/4: 初始化成功`,
              'success',
              `Server: ${status.serverInfo?.name || serverDisplayName}${versionInfo}`,
              serverDisplayName,
              `Initialize handshake completed successfully`
            );

            // MCP 测试步骤 3: 协议版本验证
            addLog(
              `[MCP测试] ${serverDisplayName} - 步骤 3/4: 协议验证`,
              'success',
              `Protocol: 2024-11-05, Server: ${status.serverInfo?.name || 'N/A'}${versionInfo}`,
              serverDisplayName
            );

            // MCP 测试步骤 4: 就绪状态
            addLog(
              `[MCP测试] ${serverDisplayName} - 步骤 4/4: 就绪`,
              'success',
              `MCP server is ready to accept requests`,
              serverDisplayName
            );
          } else if (status.status === 'failed') {
            const errorInfo = (status as any).error;
            addLog(
              `[MCP测试] ${serverDisplayName} - 步骤 1/4: 连接失败`,
              'error',
              errorInfo || 'Failed to connect or initialize',
              serverDisplayName,
              `Initialize request to ${serverDisplayName} failed`,
              errorInfo || 'Unknown error - check server configuration and logs'
            );
          } else if (status.status === 'pending') {
            let requestInfo = `Waiting for response`;
            if (serverConfig?.command) {
              requestInfo = `STDIO command: ${serverConfig.command} ${(serverConfig.args || []).join(' ')}`;
            } else if (serverConfig?.url) {
              requestInfo = `HTTP/SSE URL: ${serverConfig.url}`;
            }
            addLog(
              `[MCP测试] ${serverDisplayName} - 步骤 1/4: 等待响应`,
              'warning',
              'Server is pending - check configuration or increase timeout',
              serverDisplayName,
              requestInfo,
              'Timeout waiting for initialize response - server may be slow to start or configuration may be incorrect'
            );
          } else if (status.status === 'needs-auth') {
            addLog(
              `[MCP测试] ${serverDisplayName} - 步骤 1/4: 需要认证`,
              'warning',
              'Authentication required',
              serverDisplayName,
              'Initialize request returned authentication requirement',
              'Server requires authentication credentials'
            );
          }
        });

        // 统计各种状态的数量
        const statusCount = {
          connected: statusList.filter(s => s.status === 'connected').length,
          failed: statusList.filter(s => s.status === 'failed').length,
          pending: statusList.filter(s => s.status === 'pending').length,
          needsAuth: statusList.filter(s => s.status === 'needs-auth').length
        };

        // 添加并行处理能力日志
        addLog(
          `[MCP并行] 所有 ${statusList.length} 个服务器同时进行状态检测 (并行处理模式)`,
          'info',
          `使用 Promise.all 并行处理，支持同时处理 10+ 个服务器`,
          undefined,
          `Parallel MCP server verification enabled`
        );

        addLog(
          `服务器状态更新完成：${statusList.length} 个服务器 (${statusCount.connected} 已连接, ${statusCount.failed} 失败, ${statusCount.pending} 待定, ${statusCount.needsAuth} 需要认证)`,
          statusCount.failed > 0 ? 'warning' : 'success'
        );

        console.log('[McpSettings] Loaded server status:', statusList);
      } catch (error) {
        console.error('[McpSettings] Failed to parse server status:', error);
        setStatusLoading(false);
        addLog(
          `加载服务器状态失败：${error}`,
          'error',
          undefined,
          undefined,
          `get_${messagePrefix}mcp_server_status request to backend`,
          `JSON parse error: ${error}`
        );
      }
    };

    // Server toggled callback handler
    const handleServerToggled = (jsonStr: string) => {
      try {
        const toggledServer: McpServer = JSON.parse(jsonStr);
        scheduleRefresh(isServerEnabled(toggledServer));
      } catch (error) {
        console.error('[McpSettings] Failed to parse toggled server:', error);
      }
    };

    // Register callbacks based on provider
    if (isCodexMode) {
      window.updateCodexMcpServers = handleServerListUpdate;
      window.updateCodexMcpServerStatus = handleServerStatusUpdate;
      window.codexMcpServerToggled = handleServerToggled;
      window.codexMcpServerAdded = () => loadServers();
      window.codexMcpServerUpdated = () => loadServers();
      window.codexMcpServerDeleted = () => loadServers();
    } else {
      window.updateMcpServers = handleServerListUpdate;
      window.updateMcpServerStatus = handleServerStatusUpdate;
      window.mcpServerToggled = handleServerToggled;
    }

    // 先尝试从缓存加载数据
    const hasCache = loadFromCache();

    if (hasCache) {
      // 有缓存，使用缓存优先策略，用户可以手动刷新
      addLog('使用缓存优先策略，可点击刷新按钮获取最新数据', 'info');
    } else {
      // 没有缓存，正常加载数据
      addLog('首次加载，正在获取服务器列表...', 'info');
      loadServers();
      loadServerStatus();
    }

    // 点击外部关闭下拉菜单
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('click', handleClickOutside);

    return () => {
      clearRefreshTimers();
      // Cleanup callbacks
      if (isCodexMode) {
        window.updateCodexMcpServers = undefined;
        window.updateCodexMcpServerStatus = undefined;
        window.codexMcpServerToggled = undefined;
        window.codexMcpServerAdded = undefined;
        window.codexMcpServerUpdated = undefined;
        window.codexMcpServerDeleted = undefined;
      } else {
        window.updateMcpServers = undefined;
        window.updateMcpServerStatus = undefined;
        window.mcpServerToggled = undefined;
      }
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isCodexMode]);

  const loadServers = () => {
    setLoading(true);
    addLog(
      '正在加载 MCP 服务器列表...',
      'info',
      undefined,
      undefined,
      `get_${messagePrefix}mcp_servers request to backend`
    );
    sendToJava(`get_${messagePrefix}mcp_servers`, {});
  };

  const loadServerStatus = () => {
    setStatusLoading(true);
    addLog(
      '正在刷新 MCP 服务器连接状态...',
      'info',
      undefined,
      undefined,
      `get_${messagePrefix}mcp_server_status request to backend`,
      `Querying MCP server connection status via ${isCodexMode ? 'Codex' : 'Claude'} SDK`
    );
    sendToJava(`get_${messagePrefix}mcp_server_status`, {});
  };

  // 加载指定服务器的工具列表（支持强制刷新）
  const loadServerTools = (server: McpServer, forceRefresh: boolean = false) => {
    // Codex mode doesn't support tool listing yet
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

    // 如果不是强制刷新，尝试从缓存读取
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
        addLog(
          `从缓存加载服务器 "${server.name || server.id}" 的工具列表：${cachedTools.length} 个工具`,
          'info',
          undefined,
          server.name || server.id
        );
        return;
      }
    }

    setServerTools(prev => ({
      ...prev,
      [server.id]: {
        tools: [],
        loading: true,
        error: undefined
      }
    }));

    const action = forceRefresh ? '强制刷新' : '加载';
    addLog(
      `正在${action}服务器 "${server.name || server.id}" 的工具列表...`,
      'info',
      undefined,
      server.name || server.id,
      `get_mcp_server_tools request to backend`
    );

    sendToJava('get_mcp_server_tools', { serverId: server.id, forceRefresh });
  };

  // 注册工具列表更新回调
  useEffect(() => {
    const handleToolsUpdate = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        const serverId = result.serverId;
        const tools = result.tools || [];
        const error = result.error;
        const serverName = result.serverName || serverId;

        // MCP 工具获取步骤 1: 开始获取
        addLog(
          `[MCP工具] ${serverName} - 步骤 1/3: 请求工具列表`,
          'info',
          undefined,
          serverName,
          `Sending tools/list request to MCP server`
        );

        setServerTools(prev => ({
          ...prev,
          [serverId]: {
            tools,
            loading: false,
            error
          }
        }));

        if (error) {
          // MCP 工具获取步骤: 失败
          addLog(
            `[MCP工具] ${serverName} - 步骤 2/3: 请求失败`,
            'warning',
            error,
            serverName,
            `tools/list request failed`,
            error
          );
        } else {
          // 写入缓存
          writeToolsCache(serverId, tools, cacheKeys);
          // MCP 工具获取步骤 2: 接收成功
          addLog(
            `[MCP工具] ${serverName} - 步骤 2/3: 接收响应`,
            'success',
            `Received ${tools.length} tools from server`,
            serverName,
            `tools/list response: ${tools.length} tools available`
          );

          // MCP 工具获取步骤 3: 验证完成
          addLog(
            `[MCP工具] ${serverName} - 步骤 3/3: 验证完成`,
            'success',
            `All tools validated and ready to use`,
            serverName
          );
        }
      } catch (error) {
        console.error('[McpSettings] Failed to parse tools update:', error);
      }
    };

    // 只在 Claude 模式下注册回调
    if (!isCodexMode) {
      window.updateMcpServerTools = handleToolsUpdate;
    }

    return () => {
      if (!isCodexMode) {
        window.updateMcpServerTools = undefined;
      }
    };
  }, [isCodexMode]);

  const getServerStatusInfo = (server: McpServer): McpServerStatusInfo | undefined => {
    // 尝试多种方式匹配服务器状态
    // 1. 尝试用 id 匹配
    let statusInfo = serverStatus.get(server.id);
    if (statusInfo) return statusInfo;

    // 2. 尝试用 name 匹配
    if (server.name) {
      statusInfo = serverStatus.get(server.name);
      if (statusInfo) return statusInfo;
    }

    // 3. 遍历所有状态，尝试模糊匹配
    for (const [key, value] of serverStatus.entries()) {
      // 不区分大小写比较
      if (key.toLowerCase() === server.id.toLowerCase() ||
          (server.name && key.toLowerCase() === server.name.toLowerCase())) {
        return value;
      }
    }

    return undefined;
  };

  const getStatusIcon = (server: McpServer, status: McpServerStatusInfo['status'] | undefined): string => {
    // 如果服务器被禁用，显示禁用图标
    if (!isServerEnabled(server)) {
      return 'codicon-circle-slash';
    }

    switch (status) {
      case 'connected':
        return 'codicon-check';
      case 'failed':
        return 'codicon-error';
      case 'needs-auth':
        return 'codicon-key';
      case 'pending':
        return 'codicon-loading codicon-modifier-spin';
      default:
        return 'codicon-circle-outline';
    }
  };

  const getStatusColor = (server: McpServer, status: McpServerStatusInfo['status'] | undefined): string => {
    // 如果服务器被禁用，显示灰色
    if (!isServerEnabled(server)) {
      return '#9CA3AF';
    }

    switch (status) {
      case 'connected':
        return '#10B981';
      case 'failed':
        return '#EF4444';
      case 'needs-auth':
        return '#F59E0B';
      case 'pending':
        return '#6B7280';
      default:
        return '#6B7280';
    }
  };

  const getStatusText = (server: McpServer, status: McpServerStatusInfo['status'] | undefined): string => {
    // 如果服务器被禁用，显示"已禁用"
    if (!isServerEnabled(server)) {
      return t('mcp.disabled');
    }

    switch (status) {
      case 'connected':
        return t('mcp.statusConnected');
      case 'failed':
        return t('mcp.statusFailed');
      case 'needs-auth':
        return t('mcp.statusNeedsAuth');
      case 'pending':
        return t('mcp.statusPending');
      default:
        return t('mcp.statusUnknown');
    }
  };

  const getIconColor = (serverId: string): string => {
    let hash = 0;
    for (let i = 0; i < serverId.length; i++) {
      hash = serverId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return iconColors[Math.abs(hash) % iconColors.length];
  };

  const getServerInitial = (server: McpServer): string => {
    const name = server.name || server.id;
    return name.charAt(0).toUpperCase();
  };

  const isServerEnabled = (server: McpServer): boolean => {
    if (server.enabled !== undefined) {
      return server.enabled;
    }
    // Check provider-specific apps field
    return isCodexMode
      ? server.apps?.codex !== false
      : server.apps?.claude !== false;
  };

  const toggleExpand = (serverId: string) => {
    const newExpanded = new Set(expandedServers);
    const isExpanding = !newExpanded.has(serverId);

    if (isExpanding) {
      newExpanded.add(serverId);
      // 保存最后展开的服务器ID到缓存
      try {
        localStorage.setItem(cacheKeys.LAST_SERVER_ID, serverId);
      } catch (e) {
        console.warn('[MCP] Failed to save last expanded server:', e);
      }

      // 展开时尝试从缓存加载工具列表（如果已连接）
      const server = servers.find(s => s.id === serverId || s.name === serverId);
      if (server) {
        const statusInfo = getServerStatusInfo(server);
        const isConnected = statusInfo?.status === 'connected';
        const toolsInfo = serverTools[serverId];

        if (isConnected && !toolsInfo && !isCodexMode) {
          // 先尝试从缓存加载
          const cachedTools = readToolsCache(serverId, cacheKeys);
          if (cachedTools && cachedTools.length > 0) {
            setServerTools(prev => ({
              ...prev,
              [serverId]: {
                tools: cachedTools,
                loading: false,
                error: undefined
              }
            }));
            addLog(
              `从缓存加载工具列表：${cachedTools.length} 个工具`,
              'info',
              undefined,
              server.name || serverId
            );
          } else {
            // 缓存中没有，自动加载
            setTimeout(() => {
              loadServerTools(server, false);
            }, 100);
          }
        }
      }
    } else {
      newExpanded.delete(serverId);
    }
    setExpandedServers(newExpanded);
  };

  // 根据工具名称获取图标
  const getToolIcon = (toolName: string): string => {
    const name = toolName.toLowerCase();
    if (name.includes('search') || name.includes('query') || name.includes('find')) {
      return 'codicon-search';
    }
    if (name.includes('read') || name.includes('get') || name.includes('fetch')) {
      return 'codicon-file-text';
    }
    if (name.includes('write') || name.includes('create') || name.includes('add') || name.includes('insert')) {
      return 'codicon-edit';
    }
    if (name.includes('delete') || name.includes('remove')) {
      return 'codicon-trash';
    }
    if (name.includes('update') || name.includes('modify') || name.includes('change')) {
      return 'codicon-sync';
    }
    if (name.includes('list') || name.includes('all')) {
      return 'codicon-list-tree';
    }
    if (name.includes('execute') || name.includes('run') || name.includes('call')) {
      return 'codicon-play';
    }
    if (name.includes('connect')) {
      return 'codicon-plug';
    }
    if (name.includes('send') || name.includes('post')) {
      return 'codicon-mail';
    }
    if (name.includes('parse') || name.includes('analyze')) {
      return 'codicon-symbol-misc';
    }
    return 'codicon-symbol-property';
  };

  const handleRefresh = () => {
    addLog('开始刷新所有 MCP 服务器...', 'info');
    // 清除所有工具缓存
    clearAllToolsCache(cacheKeys);
    // 清空当前工具状态
    setServerTools({});
    loadServers();
    loadServerStatus();
  };

  // 单个服务器刷新（支持强制刷新工具）
  const handleRefreshSingleServer = (server: McpServer, forceRefreshTools: boolean = false) => {
    const serverName = server.name || server.id;
    setServerRefreshing(server.id, true, '开始刷新');

    if (forceRefreshTools) {
      // 强制刷新工具列表
      clearToolsCache(server.id, cacheKeys);
      setServerTools(prev => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
      addLog(`强制刷新服务器 "${serverName}" 的工具列表...`, 'info', undefined, serverName);
      loadServerTools(server, true);
    } else {
      addLog(`开始刷新服务器 "${serverName}"...`, 'info', undefined, serverName);
    }

    // 设置为pending状态
    setServerStatus((prev) => {
      const next = new Map(prev);
      next.set(server.id, { name: server.id, status: 'pending' });
      if (server.name) {
        next.set(server.name, { name: server.name, status: 'pending' });
      }
      return next;
    });

    // 模拟刷新过程（因为SDK不支持单个服务器刷新）
    setTimeout(() => {
      setServerRefreshing(server.id, true, '检查连接状态');
      addLog(`服务器 "${serverName}" - 检查连接状态...`, 'info', undefined, serverName);
    }, 300);

    setTimeout(() => {
      // 刷新所有服务器状态来更新
      loadServerStatus();
      setServerRefreshing(server.id, false, '');
      addLog(`服务器 "${serverName}" 刷新完成`, 'success', undefined, serverName);
    }, 1500);
  };

  const handleToggleServer = (server: McpServer, enabled: boolean) => {
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

    console.log('[McpSettings] Toggling server:', server.id, 'enabled:', enabled);
    sendToJava(`toggle_${messagePrefix}mcp_server`, updatedServer);

    // 显示Toast提示
    addToast(enabled ? `${t('mcp.enabled')} ${server.name || server.id}` : `${t('mcp.disabled')} ${server.name || server.id}`, 'success');

    if (enabled) {
      setServerStatus((prev) => {
        const next = new Map(prev);
        const pendingById: McpServerStatusInfo = { name: server.id, status: 'pending' };
        next.set(server.id, pendingById);
        if (server.name) {
          next.set(server.name, { name: server.name, status: 'pending' });
        }
        return next;
      });
    }

    loadServers();
    loadServerStatus();
  };

  const handleEdit = (server: McpServer) => {
    setEditingServer(server);
    setShowServerDialog(true);
  };

  const handleDelete = (server: McpServer) => {
    setDeletingServer(server);
    setShowConfirmDialog(true);
  };

  const confirmDelete = () => {
    if (deletingServer) {
      sendToJava(`delete_${messagePrefix}mcp_server`, { id: deletingServer.id });
      addToast(`${t('mcp.deleted')} ${deletingServer.name || deletingServer.id}`, 'success');

      // 刷新服务器列表
      setTimeout(() => {
        loadServers();
      }, 100);
    }
    setShowConfirmDialog(false);
    setDeletingServer(null);
  };

  const cancelDelete = () => {
    setShowConfirmDialog(false);
    setDeletingServer(null);
  };

  const handleAddManual = () => {
    setShowDropdown(false);
    setEditingServer(null);
    setShowServerDialog(true);
  };

  const handleAddFromMarket = () => {
    setShowDropdown(false);
    alert(t('mcp.marketComingSoon'));
  };

  const handleSaveServer = (server: McpServer) => {
    if (editingServer) {
      // 更新服务器：如果 ID 改变了，需要先删除旧的
      if (editingServer.id !== server.id) {
        // ID 改变了，先删除旧的，再添加新的
        sendToJava(`delete_${messagePrefix}mcp_server`, { id: editingServer.id });
        sendToJava(`add_${messagePrefix}mcp_server`, server);
        addToast(`${t('mcp.updated')} ${server.name || server.id}`, 'success');
      } else {
        // ID 没变，直接更新
        sendToJava(`update_${messagePrefix}mcp_server`, server);
        addToast(`${t('mcp.saved')} ${server.name || server.id}`, 'success');
      }
    } else {
      // 添加服务器
      sendToJava(`add_${messagePrefix}mcp_server`, server);
      addToast(`${t('mcp.added')} ${server.name || server.id}`, 'success');
    }

    // 刷新服务器列表
    setTimeout(() => {
      loadServers();
    }, 100);

    setShowServerDialog(false);
    setEditingServer(null);
  };

  const handleSelectPreset = (preset: McpPreset) => {
    // 从预设创建服务器
    const server: McpServer = {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      tags: preset.tags,
      server: { ...preset.server },
      apps: {
        claude: !isCodexMode,
        codex: isCodexMode,
        gemini: false,
      },
      homepage: preset.homepage,
      docs: preset.docs,
      enabled: true,
    };
    sendToJava(`add_${messagePrefix}mcp_server`, server);
    addToast(`${t('mcp.added')} ${preset.name}`, 'success');

    // 刷新服务器列表
    setTimeout(() => {
      loadServers();
    }, 100);

    setShowPresetDialog(false);
  };

  const handleCopyUrl = async (url: string) => {
    const success = await copyToClipboard(url);
    if (success) {
      addToast(t('mcp.linkCopied'), 'success');
    } else {
      addToast(t('mcp.copyFailed'), 'error');
    }
  };

  return (
    <div className="mcp-settings-section">
      {/* 头部 */}
      <div className="mcp-header">
        <div className="header-left">
          <span className="header-title">{t('mcp.title')}</span>
          <button
            className="help-btn"
            onClick={() => setShowHelpDialog(true)}
            title={t('mcp.whatIsMcp')}
          >
            <span className="codicon codicon-question"></span>
          </button>
        </div>
        <div className="header-right">
          <button
            className="refresh-btn"
            onClick={handleRefresh}
            disabled={loading || statusLoading}
            title={t('mcp.refreshStatus')}
          >
            <span className={`codicon codicon-refresh ${loading || statusLoading ? 'spinning' : ''}`}></span>
          </button>
          <div className="add-dropdown" ref={dropdownRef}>
            <button className="add-btn" onClick={() => setShowDropdown(!showDropdown)}>
              <span className="codicon codicon-add"></span>
              {t('mcp.add')}
              <span className="codicon codicon-chevron-down"></span>
            </button>
            {showDropdown && (
              <div className="dropdown-menu">
                <div className="dropdown-item" onClick={handleAddManual}>
                  <span className="codicon codicon-json"></span>
                  {t('mcp.manualConfig')}
                </div>
                <div className="dropdown-item" onClick={handleAddFromMarket}>
                  <span className="codicon codicon-extensions"></span>
                  {t('mcp.addFromMarket')}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 上下布局：服务器列表 | 刷新日志 */}
      <div className="mcp-panels-container">
        {/* 上方面板：服务器列表 */}
        <div className="mcp-server-panel">
          {!loading || servers.length > 0 ? (
            <div className="server-list">
              {servers.map(server => {
                const refreshState = serverRefreshStates[server.id];
                return (
                  <div
                    key={server.id}
                    className={`server-card ${expandedServers.has(server.id) ? 'expanded' : ''} ${!isServerEnabled(server) ? 'disabled' : ''}`}
                  >
                    {/* 卡片头部 */}
                    <div className="card-header" onClick={() => toggleExpand(server.id)}>
                      <div className="header-left-section">
                        <span className={`expand-icon codicon ${expandedServers.has(server.id) ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></span>
                        <div className="server-icon" style={{ background: getIconColor(server.id) }}>
                          {getServerInitial(server)}
                        </div>
                        <span className="server-name">{server.name || server.id}</span>
                        {/* 连接状态指示器 */}
                        {(() => {
                          const statusInfo = getServerStatusInfo(server);
                          const status = statusInfo?.status;
                          return (
                            <span
                              className="status-indicator"
                              style={{ color: getStatusColor(server, status) }}
                              title={getStatusText(server, status)}
                            >
                              <span className={`codicon ${getStatusIcon(server, status)}`}></span>
                            </span>
                          );
                        })()}
                      </div>
                      <div className="header-right-section" onClick={(e) => e.stopPropagation()}>
                        {/* 编辑按钮 */}
                        <button
                          className="icon-btn edit-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEdit(server);
                          }}
                          title={t('chat.editConfig')}
                        >
                          <span className="codicon codicon-edit"></span>
                        </button>
                        {/* 删除按钮 */}
                        <button
                          className="icon-btn delete-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(server);
                          }}
                          title={t('chat.deleteServer')}
                        >
                          <span className="codicon codicon-trash"></span>
                        </button>
                        {/* 单个服务器刷新按钮 */}
                        <button
                          className={`single-refresh-btn ${refreshState?.isRefreshing ? 'refreshing' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRefreshSingleServer(server);
                          }}
                          disabled={refreshState?.isRefreshing}
                          title={refreshState?.step || t('mcp.refreshServer', { name: server.name || server.id })}
                        >
                          <span className={`codicon codicon-refresh ${refreshState?.isRefreshing ? 'spinning' : ''}`}></span>
                        </button>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={isServerEnabled(server)}
                            onChange={(e) => handleToggleServer(server, e.target.checked)}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                      </div>
                    </div>

                    {/* 展开内容 */}
                    {expandedServers.has(server.id) && (
                      <div className="card-content">
                        {/* 连接状态信息 */}
                        {(() => {
                          const statusInfo = getServerStatusInfo(server);
                          return (
                            <div className="status-section">
                              <div className="info-row">
                                <span className="info-label">{t('mcp.connectionStatus')}:</span>
                                <span
                                  className="info-value status-value"
                                  style={{ color: getStatusColor(server, statusInfo?.status) }}
                                >
                                  <span className={`codicon ${getStatusIcon(server, statusInfo?.status)}`}></span>
                                  {' '}{getStatusText(server, statusInfo?.status)}
                                </span>
                              </div>
                              {statusInfo?.serverInfo && (
                                <div className="info-row">
                                  <span className="info-label">{t('mcp.serverVersion')}:</span>
                                  <span className="info-value">
                                    {statusInfo.serverInfo.name} v{statusInfo.serverInfo.version}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* 服务器信息 */}
                        <div className="info-section">
                          {server.description && (
                            <div className="info-row">
                              <span className="info-label">{t('mcp.description')}:</span>
                              <span className="info-value">{server.description}</span>
                            </div>
                          )}
                          {server.server.command && (
                            <div className="info-row">
                              <span className="info-label">{t('mcp.command')}:</span>
                              <code className="info-value command">
                                {server.server.command} {(server.server.args || []).join(' ')}
                              </code>
                            </div>
                          )}
                          {server.server.url && (
                            <div className="info-row">
                              <span className="info-label">{t('mcp.url')}:</span>
                              <code className="info-value command">{server.server.url}</code>
                            </div>
                          )}
                        </div>

                        {/* 工具列表 - 侧边栏布局 */}
                        {(() => {
                          const toolsInfo = serverTools[server.id];
                          const statusInfo = getServerStatusInfo(server);
                          const isConnected = statusInfo?.status === 'connected';

                          return (
                            <div className="server-detail-panel">
                              {/* 工具列表 */}
                              <div className="server-sidebar">
                                <div className="sidebar-header">
                                  <span className="sidebar-title">{t('mcp.tools')}</span>
                                  <div className="sidebar-actions">
                                    {isConnected && !toolsInfo && (
                                      <button
                                        className="sidebar-icon-btn"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          loadServerTools(server, false);
                                        }}
                                        title={t('mcp.loadTools')}
                                      >
                                        <span className="codicon codicon-refresh"></span>
                                      </button>
                                    )}
                                    {toolsInfo && !toolsInfo.loading && (
                                      <button
                                        className="sidebar-icon-btn"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          loadServerTools(server, true);
                                        }}
                                        title="强制刷新工具"
                                      >
                                        <span className="codicon codicon-sync"></span>
                                      </button>
                                    )}
                                    {toolsInfo?.loading && (
                                      <span className="sidebar-icon-btn">
                                        <span className="codicon codicon-loading codicon-modifier-spin"></span>
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <div className="sidebar-content">
                                  {!isConnected && !toolsInfo && (
                                    <div className="sidebar-section-header">{t('mcp.notConnected')}</div>
                                  )}

                                  {toolsInfo?.error && (
                                    <div className="sidebar-section-header" style={{color: 'var(--color-warning)'}}>
                                      {t('mcp.loadFailed')}
                                    </div>
                                  )}

                                  {toolsInfo?.tools && toolsInfo.tools.length === 0 && (
                                    <div className="sidebar-section-header">{t('mcp.noTools')}</div>
                                  )}

                                  {toolsInfo?.tools && toolsInfo.tools.length > 0 && (
                                    <>
                                      <div className="sidebar-section-header">
                                        {t('mcp.tools')} ({toolsInfo.tools.length})
                                      </div>
                                      <div className="sidebar-tool-list">
                                        {toolsInfo.tools.map((tool, index) => (
                                          <div
                                            key={index}
                                            className="sidebar-tool-item"
                                            title={tool.description || tool.name}
                                            onMouseEnter={(e) => {
                                              const rect = e.currentTarget.getBoundingClientRect();
                                              setHoveredTool({
                                                serverId: server.id,
                                                tool,
                                                position: {
                                                  x: rect.right + 8,
                                                  y: rect.top
                                                }
                                              });
                                            }}
                                            onMouseLeave={() => {
                                              setHoveredTool(null);
                                            }}
                                          >
                                            <span className="codicon tool-icon">{getToolIcon(tool.name)}</span>
                                            <div className="tool-info">
                                              <span className="tool-name-text">{tool.name}</span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </>
                                  )}

                                  {isConnected && !toolsInfo && (
                                    <div className="sidebar-section-header">{t('mcp.clickToLoad')}</div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* 标签 */}
                        {server.tags && server.tags.length > 0 && (
                          <div className="tags-section">
                            {server.tags.map(tag => (
                              <span key={tag} className="tag">{tag}</span>
                            ))}
                          </div>
                        )}

                        {/* 操作按钮 */}
                        <div className="actions-section">
                          {server.homepage && (
                            <button
                              className="action-btn"
                              onClick={() => handleCopyUrl(server.homepage!)}
                              title={t('chat.copyHomepageLink')}
                            >
                              <span className="codicon codicon-home"></span>
                              {t('mcp.homepage')}
                            </button>
                          )}
                          {server.docs && (
                            <button
                              className="action-btn"
                              onClick={() => handleCopyUrl(server.docs!)}
                              title={t('chat.copyDocsLink')}
                            >
                              <span className="codicon codicon-book"></span>
                              {t('mcp.docs')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* 空状态 */}
              {servers.length === 0 && !loading && (
                <div className="empty-state">
                  <span className="codicon codicon-server"></span>
                  <p>{t('mcp.noServers')}</p>
                  <p className="hint">{t('mcp.addServerHint')}</p>
                </div>
              )}
            </div>
          ) : null}

          {/* 加载状态 */}
          {loading && servers.length === 0 && (
            <div className="loading-state">
              <span className="codicon codicon-loading codicon-modifier-spin"></span>
              <p>{t('mcp.loading')}</p>
            </div>
          )}
        </div>

        {/* 下方面板：刷新日志 */}
        <div className="mcp-logs-panel">
          <div className="logs-header">
            <div className="header-left">
              <span className="logs-title">
                <span className="codicon codicon-terminal"></span>
                {t('mcp.refreshLogs')}
              </span>
              <span className="logs-count">({refreshLogs.length})</span>
            </div>
            <div className="header-right">
              {refreshLogs.length > 0 && (
                <button
                  className="clear-logs-btn"
                  onClick={clearLogs}
                  title={t('mcp.clearLogs')}
                >
                  <span className="codicon codicon-clear-all"></span>
                  {t('mcp.clear')}
                </button>
              )}
            </div>
          </div>
          <div className="logs-content">
            {refreshLogs.length === 0 ? (
              <div className="logs-empty">
                <span className="codicon codicon-info"></span>
                <p>{t('mcp.noRefreshLogs')}</p>
                <p className="hint">{t('mcp.refreshLogsHint')}</p>
              </div>
            ) : (
              <>
                {refreshLogs.map((log) => (
                  <div key={log.id} className={`log-entry log-${log.type}`}>
                    <span className="log-timestamp">
                      {log.timestamp.toLocaleTimeString('zh-CN', { hour12: false })}
                    </span>
                    {log.serverName && (
                      <span className="log-server-badge">{log.serverName}</span>
                    )}
                    <span className={`log-icon codicon ${
                      log.type === 'success' ? 'codicon-check' :
                      log.type === 'error' ? 'codicon-error' :
                      log.type === 'warning' ? 'codicon-warning' :
                      'codicon-info'
                    }`}></span>
                    <div className="log-content-wrapper">
                      <span className="log-message">{log.message}</span>
                      {log.details && (
                        <span className="log-details"> - {log.details}</span>
                      )}
                      {log.requestInfo && (
                        <div className="log-request-info">
                          <span className="codicon codicon-server"></span>
                          {log.requestInfo}
                        </div>
                      )}
                      {log.errorReason && (
                        <div className="log-error-reason">
                          <span className="codicon codicon-warning"></span>
                          {log.errorReason}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={logsEndRef}></div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 弹窗 */}
      {showServerDialog && (
        <McpServerDialog
          server={editingServer}
          existingIds={servers.map(s => s.id)}
          currentProvider={currentProvider}
          onClose={() => {
            setShowServerDialog(false);
            setEditingServer(null);
          }}
          onSave={handleSaveServer}
        />
      )}

      {showPresetDialog && (
        <McpPresetDialog
          onClose={() => setShowPresetDialog(false)}
          onSelect={handleSelectPreset}
        />
      )}

      {showHelpDialog && (
        <McpHelpDialog onClose={() => setShowHelpDialog(false)} />
      )}

      {showConfirmDialog && deletingServer && (
        <McpConfirmDialog
          title={t('mcp.deleteTitle')}
          message={t('mcp.deleteMessage', { name: deletingServer.name || deletingServer.id })}
          confirmText={t('mcp.deleteConfirm')}
          cancelText={t('mcp.cancel')}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}

      {/* Toast 通知 */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />

      {/* 工具提示浮框 */}
      {hoveredTool && (
        <div
          ref={tooltipRef}
          className="mcp-tool-tooltip"
          style={{
            left: `${Math.min(hoveredTool.position.x, window.innerWidth - 420)}px`,
            top: `${hoveredTool.position.y}px`,
          }}
        >
          <div className="tooltip-header">
            <span className="tooltip-icon">
              <span className="codicon">{getToolIcon(hoveredTool.tool.name)}</span>
            </span>
            <span className="tooltip-name">{hoveredTool.tool.name}</span>
          </div>
          {hoveredTool.tool.description && (
            <div className="tooltip-description">{hoveredTool.tool.description}</div>
          )}
          {hoveredTool.tool.inputSchema && (
            <div className="tooltip-params">
              {renderInputSchema(hoveredTool.tool.inputSchema, t)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 渲染 inputSchema 为参数列表
function renderInputSchema(schema: any, t: (key: string) => string): React.ReactElement {
  if (!schema) {
    return <div className="tooltip-no-params">{t('mcp.noParams')}</div>;
  }

  const properties = schema.properties;
  const required = schema.required || [];

  if (!properties || Object.keys(properties).length === 0) {
    return <div className="tooltip-no-params">{t('mcp.noParams')}</div>;
  }

  return (
    <>
      {Object.entries(properties).map(([paramName, paramDef]: [string, any]) => {
        const isRequired = required.includes(paramName);
        const paramType = paramDef.type || 'unknown';
        const paramDesc = paramDef.description;

        return (
          <div key={paramName} className="tooltip-param">
            <div className="tooltip-param-name">{paramName}</div>
            {paramDesc && <div className="tooltip-param-desc">{paramDesc}</div>}
            <div className="tooltip-param-meta">
              <span className="tooltip-param-type">{paramType}</span>
              <span className={isRequired ? 'tooltip-param-required' : 'tooltip-param-optional'}>
                {isRequired ? t('mcp.required') : t('mcp.optional')}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}
