/**
 * Server Card Details Component
 * Expanded content of a server card: connection status, server info,
 * tools panel, tags, and homepage/docs action buttons
 */

import type { McpServer, McpServerStatusInfo } from '../../types/mcp';
import type { ServerToolsState, McpTool } from './types';
import { getStatusIcon, getStatusText } from './utils';
import { ServerToolsPanel } from './ServerToolsPanel';

export interface ServerCardDetailsProps {
  server: McpServer;
  statusInfo: McpServerStatusInfo | undefined;
  effectiveStatus: McpServerStatusInfo['status'] | undefined;
  isConnected: boolean;
  isCodexMode: boolean;
  toolsInfo?: ServerToolsState[string];
  statusColorStyle: React.CSSProperties;
  t: (key: string, options?: Record<string, unknown>) => string;
  onLoadTools: (forceRefresh: boolean) => void;
  onCopyUrl: (url: string) => void;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * Expanded server card details
 */
export function ServerCardDetails({
  server,
  statusInfo,
  effectiveStatus,
  isConnected,
  isCodexMode,
  toolsInfo,
  statusColorStyle,
  t,
  onLoadTools,
  onCopyUrl,
  onToolHover,
}: ServerCardDetailsProps) {
  return (
    <div className="card-content">
      {/* Connection status info */}
      <div className="status-section">
        <div className="info-row">
          <span className="info-label">{t('mcp.connectionStatus')}:</span>
          <span
            className="info-value status-value"
            style={statusColorStyle}
          >
            <span className={`codicon ${getStatusIcon(server, effectiveStatus, isCodexMode)}`}></span>
            {' '}{getStatusText(server, effectiveStatus, isCodexMode, t)}
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

      {/* Server info */}
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

      {/* Tools list panel */}
      <ServerToolsPanel
        toolsInfo={toolsInfo}
        isConnected={isConnected}
        isCodexMode={isCodexMode}
        t={t}
        onLoadTools={onLoadTools}
        onToolHover={onToolHover}
      />

      {/* Tags */}
      {server.tags && server.tags.length > 0 && (
        <div className="tags-section">
          {server.tags.map(tag => (
            <span key={tag} className="tag">{tag}</span>
          ))}
        </div>
      )}

      {/* Action buttons */}
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
  );
}
