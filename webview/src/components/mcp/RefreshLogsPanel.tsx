/**
 * 刷新日志面板组件
 * 显示 MCP 服务器刷新操作的日志记录
 */

import { useRef, useEffect } from 'react';
import type { RefreshLog } from './types';

export interface RefreshLogsPanelProps {
  logs: RefreshLog[];
  t: (key: string, options?: Record<string, unknown>) => string;
  onClear: () => void;
}

/**
 * 刷新日志面板
 */
export function RefreshLogsPanel({
  logs,
  t,
  onClear,
}: RefreshLogsPanelProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动到日志底部
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  /**
   * 获取日志图标
   */
  const getLogIcon = (type: RefreshLog['type']): string => {
    switch (type) {
      case 'success':
        return 'codicon-check';
      case 'error':
        return 'codicon-error';
      case 'warning':
        return 'codicon-warning';
      default:
        return 'codicon-info';
    }
  };

  return (
    <div className="mcp-logs-panel">
      <div className="logs-header">
        <div className="header-left">
          <span className="logs-title">
            <span className="codicon codicon-terminal"></span>
            {t('mcp.refreshLogs')}
          </span>
          <span className="logs-count">({logs.length})</span>
        </div>
        <div className="header-right">
          {logs.length > 0 && (
            <button
              className="clear-logs-btn"
              onClick={onClear}
              title={t('mcp.clearLogs')}
            >
              <span className="codicon codicon-clear-all"></span>
              {t('mcp.clear')}
            </button>
          )}
        </div>
      </div>
      <div className="logs-content">
        {logs.length === 0 ? (
          <div className="logs-empty">
            <span className="codicon codicon-info"></span>
            <p>{t('mcp.noRefreshLogs')}</p>
            <p className="hint">{t('mcp.refreshLogsHint')}</p>
          </div>
        ) : (
          <>
            {logs.map((log) => (
              <div key={log.id} className={`log-entry log-${log.type}`}>
                <span className="log-timestamp">
                  {log.timestamp.toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                {log.serverName && (
                  <span className="log-server-badge">{log.serverName}</span>
                )}
                <span className={`log-icon codicon ${getLogIcon(log.type)}`}></span>
                <div className="log-content-wrapper">
                  <span className="log-message">{log.message}</span>
                  {log.details && (
                    <span className="log-details"> - {log.details}</span>
                  )}
                  {log.requestInfo && (
                    <div className="log-request-info">
                      <span className="codicon codicon-server"></span>
                      {log.requestInfo}
                    </div>
                  )}
                  {log.errorReason && (
                    <div className="log-error-reason">
                      <span className="codicon codicon-warning"></span>
                      {log.errorReason}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={logsEndRef}></div>
          </>
        )}
      </div>
    </div>
  );
}
