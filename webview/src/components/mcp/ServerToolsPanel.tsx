/**
 * 服务器工具列表面板组件
 * 显示服务器的工具列表，支持悬停查看工具详情
 */

import type { ServerToolsState, McpTool } from './types';
import { getToolIcon } from './utils';

export interface ServerToolsPanelProps {
  toolsInfo?: ServerToolsState[string];
  isConnected: boolean;
  isCodexMode: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  onLoadTools: (forceRefresh: boolean) => void;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * 服务器工具列表面板
 */
export function ServerToolsPanel({
  toolsInfo,
  isConnected,
  t,
  onLoadTools,
  onToolHover,
}: ServerToolsPanelProps) {
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
                  onLoadTools(false);
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
                  onLoadTools(true);
                }}
                title={t('mcp.logs.forceRefreshTools')}
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
                      onToolHover(tool, {
                        x: rect.right + 8,
                        y: rect.top
                      });
                    }}
                    onMouseLeave={() => {
                      onToolHover(null);
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
}
