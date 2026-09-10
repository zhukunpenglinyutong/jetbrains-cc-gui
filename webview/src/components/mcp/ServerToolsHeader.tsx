/**
 * Server Tools Header Component
 * Sidebar header with the tools title and load/refresh actions
 */

import type { ServerToolsState } from './types';

export interface ServerToolsHeaderProps {
  toolsInfo?: ServerToolsState[string];
  visibleToolsInfo?: ServerToolsState[string];
  isConnected: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  onLoadTools: (forceRefresh: boolean) => void;
}

/**
 * Tools sidebar header with load / force-refresh / loading actions
 */
export function ServerToolsHeader({
  toolsInfo,
  visibleToolsInfo,
  isConnected,
  t,
  onLoadTools,
}: ServerToolsHeaderProps) {
  return (
    <div className="sidebar-header">
      <span className="sidebar-title">{t('mcp.tools')}</span>
      <div className="sidebar-actions">
        {isConnected && !toolsInfo && (
          <button
            className="sidebar-icon-btn"
            onClick={(e) => {
              e.stopPropagation();
              onLoadTools(false);
            }}
            title={t('mcp.loadTools')}
          >
            <span className="codicon codicon-refresh"></span>
          </button>
        )}
        {visibleToolsInfo && !visibleToolsInfo.loading && (
          <button
            className="sidebar-icon-btn"
            onClick={(e) => {
              e.stopPropagation();
              onLoadTools(true);
            }}
            title={t('mcp.logs.forceRefreshTools')}
          >
            <span className="codicon codicon-sync"></span>
          </button>
        )}
        {visibleToolsInfo?.loading && (
          <span className="sidebar-icon-btn">
            <span className="codicon codicon-loading codicon-modifier-spin"></span>
          </span>
        )}
      </div>
    </div>
  );
}
