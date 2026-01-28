import { useTranslation } from 'react-i18next';
import type { McpLogEntry } from '../../types/mcp';

interface McpLogDialogProps {
  logs: McpLogEntry[];
  onClose: () => void;
  onClear: () => void;
}

/**
 * MCP Connection Logs Dialog
 */
export function McpLogDialog({ logs, onClose, onClear }: McpLogDialogProps) {
  const { t } = useTranslation();

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const formatTimestamp = (date: Date): string => {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getLevelIcon = (level: McpLogEntry['level']): string => {
    switch (level) {
      case 'success':
        return 'codicon-check';
      case 'error':
        return 'codicon-error';
      case 'warn':
        return 'codicon-warning';
      case 'info':
      default:
        return 'codicon-info';
    }
  };

  const getLevelColor = (level: McpLogEntry['level']): string => {
    switch (level) {
      case 'success':
        return '#10B981';
      case 'error':
        return '#EF4444';
      case 'warn':
        return '#F59E0B';
      case 'info':
      default:
        return '#6B7280';
    }
  };

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div className="dialog mcp-log-dialog">
        <div className="dialog-header">
          <h3>
            <span className="codicon codicon-output"></span>
            {t('mcp.logs.title')}
          </h3>
          <div className="header-actions">
            {logs.length > 0 && (
              <button className="clear-btn" onClick={onClear} title={t('mcp.logs.clear')}>
                <span className="codicon codicon-clear-all"></span>
              </button>
            )}
            <button className="close-btn" onClick={onClose}>
              <span className="codicon codicon-close"></span>
            </button>
          </div>
        </div>

        <div className="dialog-body">
          {logs.length === 0 ? (
            <div className="empty-logs">
              <span className="codicon codicon-output"></span>
              <p>{t('mcp.logs.empty')}</p>
            </div>
          ) : (
            <div className="log-list">
              {logs.map((log) => (
                <div key={log.id} className={`log-entry log-${log.level}`}>
                  <span className="log-time">{formatTimestamp(log.timestamp)}</span>
                  <span
                    className={`log-level codicon ${getLevelIcon(log.level)}`}
                    style={{ color: getLevelColor(log.level) }}
                  ></span>
                  <span className="log-server">[{log.serverName}]</span>
                  <span className="log-message">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <span className="log-count">
            {t('mcp.logs.count', { count: logs.length })}
          </span>
          <button className="btn btn-primary" onClick={onClose}>
            {t('mcp.logs.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
