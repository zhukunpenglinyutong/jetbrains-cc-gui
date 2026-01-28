/**
 * 服务器卡片组件
 * 显示单个 MCP 服务器的信息、状态和操作
 */

import type { McpServer, McpServerStatusInfo } from '../../types/mcp';
import type { ServerRefreshState, ServerToolsState, McpTool, CacheKeys } from './types';
import { getServerStatusInfo, getStatusIcon, getStatusColor, getStatusText, getIconColor, getServerInitial, isServerEnabled } from './utils';
import { ServerToolsPanel } from './ServerToolsPanel';

export interface ServerCardProps {
  server: McpServer;
  isExpanded: boolean;
  isCodexMode: boolean;
  serverStatus: Map<string, McpServerStatusInfo>;
  refreshState?: ServerRefreshState[string];
  toolsInfo?: ServerToolsState[string];
  cacheKeys: CacheKeys;
  t: (key: string, options?: Record<string, unknown>) => string;
  onToggleExpand: () => void;
  onToggleServer: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onLoadTools: (forceRefresh: boolean) => void;
  onCopyUrl: (url: string) => void;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * 服务器卡片组件
 */
export function ServerCard({
  server,
  isExpanded,
  isCodexMode,
  serverStatus,
  refreshState,
  toolsInfo,
  t,
  onToggleExpand,
  onToggleServer,
  onEdit,
  onDelete,
  onRefresh,
  onLoadTools,
  onCopyUrl,
  onToolHover,
}: ServerCardProps) {
  const statusInfo = getServerStatusInfo(server, serverStatus);
  const status = statusInfo?.status;
  const enabled = isServerEnabled(server, isCodexMode);
  const isConnected = statusInfo?.status === 'connected';

  return (
    <div
      className={`server-card ${isExpanded ? 'expanded' : ''} ${!enabled ? 'disabled' : ''}`}
    >
      {/* 卡片头部 */}
      <div className="card-header" onClick={onToggleExpand}>
        <div className="header-left-section">
          <span className={`expand-icon codicon ${isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></span>
          <div className="server-icon" style={{ background: getIconColor(server.id) }}>
            {getServerInitial(server)}
          </div>
          <span className="server-name">{server.name || server.id}</span>
          {/* 连接状态指示器 */}
          <span
            className="status-indicator"
            style={{ color: getStatusColor(server, status, isCodexMode) }}
            title={getStatusText(server, status, isCodexMode, t)}
          >
            <span className={`codicon ${getStatusIcon(server, status, isCodexMode)}`}></span>
          </span>
        </div>
        <div className="header-right-section" onClick={(e) => e.stopPropagation()}>
          {/* 编辑按钮 */}
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
          {/* 删除按钮 */}
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
          {/* 单个服务器刷新按钮 */}
          <button
            className={`single-refresh-btn ${refreshState?.isRefreshing ? 'refreshing' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            disabled={refreshState?.isRefreshing}
            title={refreshState?.step || t('mcp.refreshServer', { name: server.name || server.id })}
          >
            <span className={`codicon codicon-refresh ${refreshState?.isRefreshing ? 'spinning' : ''}`}></span>
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

      {/* 展开内容 */}
      {isExpanded && (
        <div className="card-content">
          {/* 连接状态信息 */}
          <div className="status-section">
            <div className="info-row">
              <span className="info-label">{t('mcp.connectionStatus')}:</span>
              <span
                className="info-value status-value"
                style={{ color: getStatusColor(server, statusInfo?.status, isCodexMode) }}
              >
                <span className={`codicon ${getStatusIcon(server, statusInfo?.status, isCodexMode)}`}></span>
                {' '}{getStatusText(server, statusInfo?.status, isCodexMode, t)}
              </span>
            </div>
            {statusInfo?.serverInfo && (
              <div className="info-row">
                <span className="info-label">{t('mcp.serverVersion')}:</span>
                <span className="info-value">
                  {statusInfo.serverInfo.name} v{statusInfo.serverInfo.version}
                </span>
              </div>
            )}
          </div>

          {/* 服务器信息 */}
          <div className="info-section">
            {server.description && (
              <div className="info-row">
                <span className="info-label">{t('mcp.description')}:</span>
                <span className="info-value">{server.description}</span>
              </div>
            )}
            {server.server.command && (
              <div className="info-row">
                <span className="info-label">{t('mcp.command')}:</span>
                <code className="info-value command">
                  {server.server.command} {(server.server.args || []).join(' ')}
                </code>
              </div>
            )}
            {server.server.url && (
              <div className="info-row">
                <span className="info-label">{t('mcp.url')}:</span>
                <code className="info-value command">{server.server.url}</code>
              </div>
            )}
          </div>

          {/* 工具列表面板 */}
          <ServerToolsPanel
            toolsInfo={toolsInfo}
            isConnected={isConnected}
            isCodexMode={isCodexMode}
            t={t}
            onLoadTools={onLoadTools}
            onToolHover={onToolHover}
          />

          {/* 标签 */}
          {server.tags && server.tags.length > 0 && (
            <div className="tags-section">
              {server.tags.map(tag => (
                <span key={tag} className="tag">{tag}</span>
              ))}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="actions-section">
            {server.homepage && (
              <button
                className="action-btn"
                onClick={() => onCopyUrl(server.homepage!)}
                title={t('chat.copyHomepageLink')}
              >
                <span className="codicon codicon-home"></span>
                {t('mcp.homepage')}
              </button>
            )}
            {server.docs && (
              <button
                className="action-btn"
                onClick={() => onCopyUrl(server.docs!)}
                title={t('chat.copyDocsLink')}
              >
                <span className="codicon codicon-book"></span>
                {t('mcp.docs')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
