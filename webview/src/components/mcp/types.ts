/**
 * MCP settings component type definitions
 */

import type { McpServer, McpServerStatusInfo } from '../../types/mcp';

// ============================================================================
// Component Props
// ============================================================================

export interface McpSettingsSectionProps {
  currentProvider?: 'claude' | 'codex' | string;
}

// ============================================================================
// Cache Types
// ============================================================================

/** Cache data structure */
export interface CachedData<T> {
  data: T;
  timestamp: number;
}

/** Tool list cache structure */
export interface ToolsCacheData {
  [serverId: string]: {
    tools: McpTool[];
    timestamp: number;
  };
}

/** Cache key collection */
export interface CacheKeys {
  SERVERS: string;
  STATUS: string;
  TOOLS: string;
  LAST_SERVER_ID: string;
}

// ============================================================================
// Server Status Types
// ============================================================================

/** Per-server refresh state */
export interface ServerRefreshState {
  [serverId: string]: {
    isRefreshing: boolean;
    step: string;
  };
}

/** MCP tool type */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Server tool list state */
export interface ServerToolsState {
  [serverId: string]: {
    tools: McpTool[];
    loading: boolean;
    error?: string;
  };
}

// ============================================================================
// Log Types
// ============================================================================

/** Refresh log entry */
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
// Re-exported MCP types
// ============================================================================

export type { McpServer, McpServerStatusInfo };
