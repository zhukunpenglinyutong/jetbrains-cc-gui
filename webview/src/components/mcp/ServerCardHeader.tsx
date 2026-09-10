/**
 * Server Card Header Component
 * Header row of a server card: expand toggle, icon, name, status badge,
 * edit/copy/delete action buttons, and the enable toggle switch
 */

import type { McpServer, McpServerStatusInfo } from '../../types/mcp';
import { getServerInitial } from './utils';
import { ServerCardStatusBadge } from './ServerCardStatusBadge';

export interface ServerCardHeaderProps {
  server: McpServer;
  isExpanded: boolean;
  enabled: boolean;
  effectiveStatus: McpServerStatusInfo['status'] | undefined;
  emptyToolsWarning: boolean;
  isCodexMode: boolean;
  iconStyle: React.CSSProperties;
  statusColorStyle: React.CSSProperties;
  t: (key: string, options?: Record<string, unknown>) => string;
  onToggleExpand: () => void;
  onToggleServer: (enabled: boolean) => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

/**
 * Server card header with identity, status badge, and action buttons
 */
export function ServerCardHeader({
  server,
  isExpanded,
  enabled,
  effectiveStatus,
  emptyToolsWarning,
  isCodexMode,
  iconStyle,
  statusColorStyle,
  t,
  onToggleExpand,
  onToggleServer,
  onEdit,
  onCopy,
  onDelete,
}: ServerCardHeaderProps) {
  return (
    <div className="card-header" onClick={onToggleExpand}>
      <div className="header-left-section">
        <span className={`expand-icon codicon ${isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></span>
        <div className="server-icon" style={iconStyle}>
          {getServerInitial(server)}
        </div>
        <span className="server-name">{server.name || server.id}</span>
        {/* Connection status indicator */}
        <ServerCardStatusBadge
          server={server}
          effectiveStatus={effectiveStatus}
          isCodexMode={isCodexMode}
          emptyToolsWarning={emptyToolsWarning}
          statusColorStyle={statusColorStyle}
          t={t}
        />
      </div>
      <div className="header-right-section" onClick={(e) => e.stopPropagation()}>
        {/* Edit button */}
        <button
          className="icon-btn edit-btn"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title={t('chat.editConfig')}
        >
          <span className="codicon codicon-edit"></span>
        </button>
        {/* Copy button */}
        <button
          className="icon-btn copy-btn"
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
          title={t('chat.copyConfig')}
        >
          <span className="codicon codicon-copy"></span>
        </button>
        {/* Delete button */}
        <button
          className="icon-btn delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={t('chat.deleteServer')}
        >
          <span className="codicon codicon-trash"></span>
        </button>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggleServer(e.target.checked)}
          />
          <span className="toggle-slider"></span>
        </label>
      </div>
    </div>
  );
}
