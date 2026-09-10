/**
 * Server Card Component
 * Displays information, status, and actions for a single MCP server
 */

import type { McpServer, McpServerStatusInfo } from '../../types/mcp';
import type { ServerRefreshState, ServerToolsState, McpTool } from './types';
import { getServerStatusInfo, getStatusColor, getIconColor, isServerEnabled } from './utils';
import { isEmptyToolsResult } from './ServerToolsPanel';
import { ServerCardHeader } from './ServerCardHeader';
import { ServerCardDetails } from './ServerCardDetails';

export interface ServerCardProps {
  server: McpServer;
  isExpanded: boolean;
  isCodexMode: boolean;
  serverStatus: Map<string, McpServerStatusInfo>;
  refreshState?: ServerRefreshState[string];
  toolsInfo?: ServerToolsState[string];
  t: (key: string, options?: Record<string, unknown>) => string;
  onToggleExpand: () => void;
  onToggleServer: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onRefresh: () => void;
  onLoadTools: (forceRefresh: boolean) => void;
  onCopyUrl: (url: string) => void;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * Server Card Component
 */
export function ServerCard({
  server,
  isExpanded,
  isCodexMode,
  serverStatus,
  toolsInfo,
  t,
  onToggleExpand,
  onToggleServer,
  onEdit,
  onDelete,
  onCopy,
  onLoadTools,
  onCopyUrl,
  onToolHover,
}: ServerCardProps) {
  const statusInfo = getServerStatusInfo(server, serverStatus);
  const status = statusInfo?.status;
  const effectiveStatus: McpServerStatusInfo['status'] | undefined =
    status === 'pending' && (toolsInfo?.tools?.length ?? 0) > 0
      ? 'connected'
      : status;
  const enabled = isServerEnabled(server, isCodexMode);
  const isConnected = effectiveStatus === 'connected';
  const emptyToolsWarning = hasEmptyToolsWarning(effectiveStatus, toolsInfo, enabled);

  const iconStyle: React.CSSProperties = { background: getIconColor(server.id) };
  const statusColorStyle: React.CSSProperties = {
    color: emptyToolsWarning ? 'var(--color-warning)' : getStatusColor(server, effectiveStatus, isCodexMode),
  };

  return (
    <div
      className={`server-card ${isExpanded ? 'expanded' : ''} ${!enabled ? 'disabled' : ''}`}
    >
      {/* Card header */}
      <ServerCardHeader
        server={server}
        isExpanded={isExpanded}
        enabled={enabled}
        effectiveStatus={effectiveStatus}
        emptyToolsWarning={emptyToolsWarning}
        isCodexMode={isCodexMode}
        iconStyle={iconStyle}
        statusColorStyle={statusColorStyle}
        t={t}
        onToggleExpand={onToggleExpand}
        onToggleServer={onToggleServer}
        onEdit={onEdit}
        onCopy={onCopy}
        onDelete={onDelete}
      />

      {/* Expanded content */}
      {isExpanded && (
        <ServerCardDetails
          server={server}
          statusInfo={statusInfo}
          effectiveStatus={effectiveStatus}
          isConnected={isConnected}
          isCodexMode={isCodexMode}
          toolsInfo={toolsInfo}
          statusColorStyle={statusColorStyle}
          t={t}
          onLoadTools={onLoadTools}
          onCopyUrl={onCopyUrl}
          onToolHover={onToolHover}
        />
      )}
    </div>
  );
}

export function hasEmptyToolsWarning(
  status: McpServerStatusInfo['status'] | undefined,
  toolsInfo: ServerToolsState[string] | undefined,
  enabled: boolean,
): boolean {
  return enabled && status === 'connected' && isEmptyToolsResult(toolsInfo);
}
