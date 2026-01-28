/**
 * MCP 设置组件类型定义
 */

import type { McpServer, McpServerStatusInfo } from '../../types/mcp';

// ============================================================================
// 组件 Props
// ============================================================================

export interface McpSettingsSectionProps {
  currentProvider?: 'claude' | 'codex' | string;
}

// ============================================================================
// 缓存相关类型
// ============================================================================

/** 缓存数据结构 */
export interface CachedData<T> {
  data: T;
  timestamp: number;
}

/** 工具列表缓存结构 */
export interface ToolsCacheData {
  [serverId: string]: {
    tools: McpTool[];
    timestamp: number;
  };
}

/** 缓存键名集合 */
export interface CacheKeys {
  SERVERS: string;
  STATUS: string;
  TOOLS: string;
  LAST_SERVER_ID: string;
}

// ============================================================================
// 服务器状态相关类型
// ============================================================================

/** 单个服务器刷新状态 */
export interface ServerRefreshState {
  [serverId: string]: {
    isRefreshing: boolean;
    step: string;
  };
}

/** MCP 工具类型 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** 服务器工具列表状态 */
export interface ServerToolsState {
  [serverId: string]: {
    tools: McpTool[];
    loading: boolean;
    error?: string;
  };
}

// ============================================================================
// 日志相关类型
// ============================================================================

/** 刷新日志类型 */
export interface RefreshLog {
  id: string;
  timestamp: Date;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  serverId?: string;
  serverName?: string;
  details?: string;
  requestInfo?: string;
  errorReason?: string;
}

// ============================================================================
// 重新导出 mcp 类型
// ============================================================================

export type { McpServer, McpServerStatusInfo };
