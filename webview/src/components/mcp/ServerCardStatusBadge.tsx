/**
 * Server Card Status Badge Component
 * Connection status indicator shown in the server card header
 */

import type { McpServer, McpServerStatusInfo } from '../../types/mcp';
import { getStatusIcon, getStatusText } from './utils';

export interface ServerCardStatusBadgeProps {
  server: McpServer;
  effectiveStatus: McpServerStatusInfo['status'] | undefined;
  isCodexMode: boolean;
  emptyToolsWarning: boolean;
  statusColorStyle: React.CSSProperties;
  t: (key: string, options?: Record<string, unknown>) => string;
}

/**
 * Connection status indicator (icon + tooltip) for the card header
 */
export function ServerCardStatusBadge({
  server,
  effectiveStatus,
  isCodexMode,
  emptyToolsWarning,
  statusColorStyle,
  t,
}: ServerCardStatusBadgeProps) {
  return (
    <span
      className="status-indicator"
      style={statusColorStyle}
      title={emptyToolsWarning
        ? `${getStatusText(server, effectiveStatus, isCodexMode, t)}: ${t('mcp.noTools')}`
        : getStatusText(server, effectiveStatus, isCodexMode, t)}
    >
      <span className={`codicon ${emptyToolsWarning
        ? 'codicon-warning'
        : getStatusIcon(server, effectiveStatus, isCodexMode)}`}></span>
    </span>
  );
}
