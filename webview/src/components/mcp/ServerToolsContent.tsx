/**
 * Server Tools Content Component
 * Sidebar content area with the tools list and its state branches
 */

import type { ServerToolsState, McpTool } from './types';
import { ServerToolList } from './ServerToolList';

const WARNING_HEADER_STYLE: React.CSSProperties = { color: 'var(--color-warning)' };

export interface ServerToolsContentProps {
  toolsInfo?: ServerToolsState[string];
  visibleToolsInfo?: ServerToolsState[string];
  isConnected: boolean;
  emptyToolsResult: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * Tools sidebar content: connection / error / empty / list states
 */
export function ServerToolsContent({
  toolsInfo,
  visibleToolsInfo,
  isConnected,
  emptyToolsResult,
  t,
  onToolHover,
}: ServerToolsContentProps) {
  return (
    <div className="sidebar-content">
      {!isConnected && !visibleToolsInfo && (
        <div className="sidebar-section-header">{t('mcp.notConnected')}</div>
      )}

      {visibleToolsInfo?.error && (
        <>
          <div className="sidebar-section-header" style={WARNING_HEADER_STYLE}>
            {t('mcp.loadFailed')}
          </div>
          <div className="mcp-load-error-detail">{visibleToolsInfo.error}</div>
        </>
      )}

      {emptyToolsResult && (
        <div
          className="sidebar-section-header"
          style={isConnected ? WARNING_HEADER_STYLE : undefined}
        >
          {t('mcp.noTools')}
        </div>
      )}

      {visibleToolsInfo?.tools && visibleToolsInfo.tools.length > 0 && (
        <ServerToolList
          tools={visibleToolsInfo.tools}
          t={t}
          onToolHover={onToolHover}
        />
      )}

      {isConnected && !toolsInfo && (
        <div className="sidebar-section-header">{t('mcp.clickToLoad')}</div>
      )}
    </div>
  );
}
