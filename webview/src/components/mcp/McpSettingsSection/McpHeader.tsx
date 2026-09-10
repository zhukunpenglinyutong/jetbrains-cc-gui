/**
 * MCP settings header: title, help/log/refresh actions and the add-server dropdown
 */

import { useRef } from 'react';

export interface McpHeaderProps {
  t: (key: string, options?: Record<string, unknown>) => string;
  logCount: number;
  loading: boolean;
  statusLoading: boolean;
  showDropdown: boolean;
  onToggleDropdown: () => void;
  onShowHelp: () => void;
  onShowLog: () => void;
  onRefresh: () => void;
  onAddManual: () => void;
  onAddFromMarket: () => void;
  onImportFromCopilot: () => void;
}

export function McpHeader({
  t,
  logCount,
  loading,
  statusLoading,
  showDropdown,
  onToggleDropdown,
  onShowHelp,
  onShowLog,
  onRefresh,
  onAddManual,
  onAddFromMarket,
  onImportFromCopilot,
}: McpHeaderProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  return (
    <div className="mcp-header">
      <div className="header-left">
        <span className="header-title">{t('mcp.title')}</span>
        <button
          className="help-btn"
          onClick={onShowHelp}
          title={t('mcp.whatIsMcp')}
        >
          <span className="codicon codicon-question"></span>
        </button>
      </div>
      <div className="header-right">
        <button
          className="log-btn"
          onClick={onShowLog}
          title={t('mcp.logs.title')}
        >
          <span className="codicon codicon-output"></span>
          {logCount > 0 && (
            <span className="log-badge">{logCount}</span>
          )}
        </button>
        <button
          className="refresh-btn"
          onClick={onRefresh}
          disabled={loading || statusLoading}
          title={t('mcp.refreshStatus')}
        >
          <span className={`codicon codicon-sync ${loading || statusLoading ? 'spinning' : ''}`}></span>
        </button>
        <div className="add-dropdown" ref={dropdownRef}>
          <button className="add-btn" onClick={onToggleDropdown}>
            <span className="codicon codicon-add"></span>
            {t('mcp.add')}
            <span className="codicon codicon-chevron-down"></span>
          </button>
          {showDropdown && (
            <div className="dropdown-menu">
              <div className="dropdown-item" onClick={onAddManual}>
                <span className="codicon codicon-json"></span>
                {t('mcp.manualConfig')}
              </div>
              <div className="dropdown-item" onClick={onAddFromMarket}>
                <span className="codicon codicon-extensions"></span>
                {t('mcp.addFromMarket')}
              </div>
              <div className="dropdown-item" onClick={onImportFromCopilot}>
                <span className="codicon codicon-github"></span>
                {t('mcp.import.menuLabel')}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
