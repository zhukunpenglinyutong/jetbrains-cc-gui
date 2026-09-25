/**
 * MCP server list panel with loading and empty states
 */

import type { McpServer, McpServerStatusInfo } from '../../../types/mcp';
import type { ServerRefreshState, ServerToolsState, McpTool } from '../types';
import { ServerCard } from '../ServerCard';
import { getServerCardKey } from '../serverCardKey';

export interface McpServerListProps {
  servers: McpServer[];
  loading: boolean;
  /** Card keys (`getServerCardKey`), not server ids — see ../serverCardKey. */
  expandedServers: Set<string>;
  isCodexMode: boolean;
  serverStatus: Map<string, McpServerStatusInfo>;
  serverRefreshStates: ServerRefreshState;
  /** Keyed by card key, not by server id — see ../serverCardKey. */
  serverTools: ServerToolsState;
  t: (key: string, options?: Record<string, unknown>) => string;
  onToggleExpand: (cardKey: string) => void;
  onToggleServer: (server: McpServer, enabled: boolean) => void;
  onEdit: (server: McpServer) => void;
  onDelete: (server: McpServer) => void;
  onCopyConfig: (server: McpServer) => void;
  onApprove: (server: McpServer) => void;
  onReject: (server: McpServer) => void;
  onRefreshServer: (server: McpServer) => void;
  onLoadTools: (server: McpServer, forceRefresh: boolean) => void;
  onCopyUrl: (url: string) => void;
  onToolHover: (tool: McpTool | null, position: { x: number; y: number } | undefined, serverId: string) => void;
}

/**
 * Every card is addressed by its card key (`getServerCardKey`), never by `server.id`:
 * a project-local .mcp.json server that collides with a global one arrives with the same
 * id as both records, and keying anything by id would make the two cards share their
 * expansion and their loaded tools. See ../serverCardKey for the full contract.
 */
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
  onApprove,
  onReject,
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
            {servers.map(server => {
              const cardKey = getServerCardKey(server);
              return (
                <ServerCard
                  key={cardKey}
                  server={server}
                  isExpanded={expandedServers.has(cardKey)}
                  isCodexMode={isCodexMode}
                  isProjectLocal={server.source === 'project'}
                  approvalStatus={server.source === 'project' ? (server.approvalStatus || 'pending') : undefined}
                  serverStatus={serverStatus}
                  refreshState={serverRefreshStates[server.id]}
                  toolsInfo={serverTools[cardKey]}
                  t={t}
                  onToggleExpand={() => onToggleExpand(cardKey)}
                  onToggleServer={(enabled) => onToggleServer(server, enabled)}
                  onEdit={() => onEdit(server)}
                  onDelete={() => onDelete(server)}
                  onCopy={() => onCopyConfig(server)}
                  onApprove={() => onApprove(server)}
                  onReject={() => onReject(server)}
                  onRefresh={() => onRefreshServer(server)}
                  onLoadTools={(forceRefresh) => onLoadTools(server, forceRefresh)}
                  onCopyUrl={onCopyUrl}
                  onToolHover={(tool, position) => onToolHover(tool, position, server.id)}
                />
              );
            })}

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
