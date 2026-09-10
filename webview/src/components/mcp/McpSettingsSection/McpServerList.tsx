/**
 * MCP server list panel with loading and empty states
 */

import type { McpServer, McpServerStatusInfo } from '../../../types/mcp';
import type { ServerRefreshState, ServerToolsState, McpTool } from '../types';
import { ServerCard } from '../ServerCard';

export interface McpServerListProps {
  servers: McpServer[];
  loading: boolean;
  expandedServers: Set<string>;
  isCodexMode: boolean;
  serverStatus: Map<string, McpServerStatusInfo>;
  serverRefreshStates: ServerRefreshState;
  serverTools: ServerToolsState;
  t: (key: string, options?: Record<string, unknown>) => string;
  onToggleExpand: (serverId: string) => void;
  onToggleServer: (server: McpServer, enabled: boolean) => void;
  onEdit: (server: McpServer) => void;
  onDelete: (server: McpServer) => void;
  onCopyConfig: (server: McpServer) => void;
  onRefreshServer: (server: McpServer) => void;
  onLoadTools: (server: McpServer, forceRefresh: boolean) => void;
  onCopyUrl: (url: string) => void;
  onToolHover: (tool: McpTool | null, position: { x: number; y: number } | undefined, serverId: string) => void;
}

export function McpServerList({
  servers,
  loading,
  expandedServers,
  isCodexMode,
  serverStatus,
  serverRefreshStates,
  serverTools,
  t,
  onToggleExpand,
  onToggleServer,
  onEdit,
  onDelete,
  onCopyConfig,
  onRefreshServer,
  onLoadTools,
  onCopyUrl,
  onToolHover,
}: McpServerListProps) {
  return (
    <div className="mcp-panels-container">
      {/* Top panel: server list */}
      <div className="mcp-server-panel">
        {!loading || servers.length > 0 ? (
          <div className="server-list">
            {servers.map(server => (
              <ServerCard
                key={server.id}
                server={server}
                isExpanded={expandedServers.has(server.id)}
                isCodexMode={isCodexMode}
                serverStatus={serverStatus}
                refreshState={serverRefreshStates[server.id]}
                toolsInfo={serverTools[server.id]}
                t={t}
                onToggleExpand={() => onToggleExpand(server.id)}
                onToggleServer={(enabled) => onToggleServer(server, enabled)}
                onEdit={() => onEdit(server)}
                onDelete={() => onDelete(server)}
                onCopy={() => onCopyConfig(server)}
                onRefresh={() => onRefreshServer(server)}
                onLoadTools={(forceRefresh) => onLoadTools(server, forceRefresh)}
                onCopyUrl={onCopyUrl}
                onToolHover={(tool, position) => onToolHover(tool, position, server.id)}
              />
            ))}

            {/* Empty state */}
            {servers.length === 0 && !loading && (
              <div className="empty-state">
                <span className="codicon codicon-server"></span>
                <p>{t('mcp.noServers')}</p>
                <p className="hint">{t('mcp.addServerHint')}</p>
              </div>
            )}
          </div>
        ) : null}

        {/* Loading state */}
        {loading && servers.length === 0 && (
          <div className="loading-state">
            <span className="codicon codicon-loading codicon-modifier-spin"></span>
            <p>{t('mcp.loading')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
