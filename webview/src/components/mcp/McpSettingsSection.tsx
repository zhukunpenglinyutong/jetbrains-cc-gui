/**
 * MCP 服务器设置组件
 * 支持 Claude 和 Codex 两种模式
 */

import { useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer, McpPreset } from '../../types/mcp';
import { sendToJava } from '../../utils/bridge';
import { McpServerDialog } from './McpServerDialog';
import { McpPresetDialog } from './McpPresetDialog';
import { McpHelpDialog } from './McpHelpDialog';
import { McpConfirmDialog } from './McpConfirmDialog';
import { ToastContainer, type ToastMessage } from '../Toast';
import { copyToClipboard } from '../../utils/copyUtils';

// 类型和工具函数
import type { McpSettingsSectionProps, RefreshLog, McpTool } from './types';
import { getCacheKeys, getToolIcon } from './utils';

// Hooks
import { useServerData } from './hooks/useServerData';
import { useServerManagement } from './hooks/useServerManagement';
import { useToolsUpdate } from './hooks/useToolsUpdate';

// 子组件
import { ServerCard } from './ServerCard';
import { RefreshLogsPanel } from './RefreshLogsPanel';

/**
 * MCP 服务器设置组件
 */
export function McpSettingsSection({ currentProvider = 'claude' }: McpSettingsSectionProps) {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';

  // Generate message type prefix based on provider
  const messagePrefix = useMemo(() => (isCodexMode ? 'codex_' : ''), [isCodexMode]);

  // Get provider-specific cache keys
  const cacheKeys = useMemo(() => getCacheKeys(isCodexMode ? 'codex' : 'claude'), [isCodexMode]);

  // 下拉菜单状态
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 工具提示浮框状态
  const [hoveredTool, setHoveredTool] = useState<{ serverId: string; tool: McpTool; position: { x: number; y: number } } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // 弹窗状态
  const [showServerDialog, setShowServerDialog] = useState(false);
  const [showPresetDialog, setShowPresetDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [deletingServer, setDeletingServer] = useState<McpServer | null>(null);

  // Toast 状态管理
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // 刷新日志状态
  const [refreshLogs, setRefreshLogs] = useState<RefreshLog[]>([]);

  // Toast 辅助函数
  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // 日志辅助函数
  const addLog = useCallback((
    message: string,
    type: RefreshLog['type'] = 'info',
    details?: string,
    serverName?: string,
    requestInfo?: string,
    errorReason?: string
  ) => {
    const id = `log-${Date.now()}-${Math.random()}`;
    const log: RefreshLog = {
      id,
      timestamp: new Date(),
      type,
      message,
      details,
      serverName,
      requestInfo,
      errorReason
    };
    setRefreshLogs((prev) => [...prev, log].slice(-100));
  }, []);

  const clearLogs = useCallback(() => {
    setRefreshLogs([]);
    addLog(t('mcp.logs.cleared'), 'info');
  }, [addLog, t]);

  // 使用服务器数据 Hook
  const {
    servers,
    serverStatus,
    loading,
    statusLoading,
    expandedServers,
    serverTools,
    setServerTools,
    setExpandedServers,
    loadServers,
    loadServerStatus,
    loadServerTools,
  } = useServerData({
    isCodexMode,
    messagePrefix,
    cacheKeys,
    t,
    onLog: addLog,
  });

  // 使用服务器管理 Hook
  const {
    serverRefreshStates,
    handleRefresh,
    handleRefreshSingleServer,
    handleToggleServer,
  } = useServerManagement({
    isCodexMode,
    messagePrefix,
    cacheKeys,
    setServerTools,
    loadServers,
    loadServerStatus,
    loadServerTools,
    onLog: addLog,
    onToast: addToast,
    t,
  });

  // 使用工具列表更新 Hook
  useToolsUpdate({
    isCodexMode,
    cacheKeys,
    setServerTools,
    onLog: addLog,
  });

  // 展开/折叠服务器
  const toggleExpand = useCallback((serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    const isExpanding = !expandedServers.has(serverId);

    if (isExpanding) {
      setExpandedServers(new Set([serverId]));
      // 保存最后展开的服务器ID到缓存
      try {
        localStorage.setItem(cacheKeys.LAST_SERVER_ID, serverId);
      } catch (e) {
        // ignore
      }

      // 展开时自动加载工具列表
      if (server && !serverTools[serverId] && !isCodexMode) {
        loadServerTools(server, false);
      }
    } else {
      const newExpanded = new Set(expandedServers);
      newExpanded.delete(serverId);
      setExpandedServers(newExpanded);
    }
  }, [servers, expandedServers, serverTools, isCodexMode, cacheKeys, setExpandedServers, loadServerTools]);

  // 编辑服务器
  const handleEdit = useCallback((server: McpServer) => {
    setEditingServer(server);
    setShowServerDialog(true);
  }, []);

  // 删除服务器
  const handleDelete = useCallback((server: McpServer) => {
    setDeletingServer(server);
    setShowConfirmDialog(true);
  }, []);

  // 确认删除
  const confirmDelete = useCallback(() => {
    if (deletingServer) {
      sendToJava(`delete_${messagePrefix}mcp_server`, { id: deletingServer.id });
      addToast(`${t('mcp.deleted')} ${deletingServer.name || deletingServer.id}`, 'success');

      setTimeout(() => {
        loadServers();
      }, 100);
    }
    setShowConfirmDialog(false);
    setDeletingServer(null);
  }, [deletingServer, messagePrefix, addToast, t, loadServers]);

  // 取消删除
  const cancelDelete = useCallback(() => {
    setShowConfirmDialog(false);
    setDeletingServer(null);
  }, []);

  // 手动添加服务器
  const handleAddManual = useCallback(() => {
    setShowDropdown(false);
    setEditingServer(null);
    setShowServerDialog(true);
  }, []);

  // 从市场添加服务器
  const handleAddFromMarket = useCallback(() => {
    setShowDropdown(false);
    alert(t('mcp.marketComingSoon'));
  }, [t]);

  // 保存服务器
  const handleSaveServer = useCallback((server: McpServer) => {
    if (editingServer) {
      if (editingServer.id !== server.id) {
        sendToJava(`delete_${messagePrefix}mcp_server`, { id: editingServer.id });
        sendToJava(`add_${messagePrefix}mcp_server`, server);
        addToast(`${t('mcp.updated')} ${server.name || server.id}`, 'success');
      } else {
        sendToJava(`update_${messagePrefix}mcp_server`, server);
        addToast(`${t('mcp.saved')} ${server.name || server.id}`, 'success');
      }
    } else {
      sendToJava(`add_${messagePrefix}mcp_server`, server);
      addToast(`${t('mcp.added')} ${server.name || server.id}`, 'success');
    }

    setTimeout(() => {
      loadServers();
    }, 100);

    setShowServerDialog(false);
    setEditingServer(null);
  }, [editingServer, messagePrefix, addToast, t, loadServers]);

  // 选择预设
  const handleSelectPreset = useCallback((preset: McpPreset) => {
    const server: McpServer = {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      tags: preset.tags,
      server: { ...preset.server },
      apps: {
        claude: !isCodexMode,
        codex: isCodexMode,
        gemini: false,
      },
      homepage: preset.homepage,
      docs: preset.docs,
      enabled: true,
    };
    sendToJava(`add_${messagePrefix}mcp_server`, server);
    addToast(`${t('mcp.added')} ${preset.name}`, 'success');

    setTimeout(() => {
      loadServers();
    }, 100);

    setShowPresetDialog(false);
  }, [isCodexMode, messagePrefix, addToast, t, loadServers]);

  // 复制 URL
  const handleCopyUrl = useCallback(async (url: string) => {
    const success = await copyToClipboard(url);
    if (success) {
      addToast(t('mcp.linkCopied'), 'success');
    } else {
      addToast(t('mcp.copyFailed'), 'error');
    }
  }, [addToast, t]);

  // 工具悬停处理
  const handleToolHover = useCallback((tool: McpTool | null, position?: { x: number; y: number }, serverId?: string) => {
    if (tool && position && serverId) {
      setHoveredTool({ serverId, tool, position });
    } else {
      setHoveredTool(null);
    }
  }, []);

  return (
    <div className="mcp-settings-section">
      {/* 头部 */}
      <div className="mcp-header">
        <div className="header-left">
          <span className="header-title">{t('mcp.title')}</span>
          <button
            className="help-btn"
            onClick={() => setShowHelpDialog(true)}
            title={t('mcp.whatIsMcp')}
          >
            <span className="codicon codicon-question"></span>
          </button>
        </div>
        <div className="header-right">
          <button
            className="refresh-btn"
            onClick={handleRefresh}
            disabled={loading || statusLoading}
            title={t('mcp.refreshStatus')}
          >
            <span className={`codicon codicon-refresh ${loading || statusLoading ? 'spinning' : ''}`}></span>
          </button>
          <div className="add-dropdown" ref={dropdownRef}>
            <button className="add-btn" onClick={() => setShowDropdown(!showDropdown)}>
              <span className="codicon codicon-add"></span>
              {t('mcp.add')}
              <span className="codicon codicon-chevron-down"></span>
            </button>
            {showDropdown && (
              <div className="dropdown-menu">
                <div className="dropdown-item" onClick={handleAddManual}>
                  <span className="codicon codicon-json"></span>
                  {t('mcp.manualConfig')}
                </div>
                <div className="dropdown-item" onClick={handleAddFromMarket}>
                  <span className="codicon codicon-extensions"></span>
                  {t('mcp.addFromMarket')}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 上下布局：服务器列表 | 刷新日志 */}
      <div className="mcp-panels-container">
        {/* 上方面板：服务器列表 */}
        <div className="mcp-server-panel">
          {!loading || servers.length > 0 ? (
            <div className="server-list">
              {servers.map(server => (
                <ServerCard
                  key={server.id}
                  server={server}
                  isExpanded={expandedServers.has(server.id)}
                  isCodexMode={isCodexMode}
                  serverStatus={serverStatus}
                  refreshState={serverRefreshStates[server.id]}
                  toolsInfo={serverTools[server.id]}
                  cacheKeys={cacheKeys}
                  t={t}
                  onToggleExpand={() => toggleExpand(server.id)}
                  onToggleServer={(enabled) => handleToggleServer(server, enabled)}
                  onEdit={() => handleEdit(server)}
                  onDelete={() => handleDelete(server)}
                  onRefresh={() => handleRefreshSingleServer(server)}
                  onLoadTools={(forceRefresh) => loadServerTools(server, forceRefresh)}
                  onCopyUrl={handleCopyUrl}
                  onToolHover={(tool, position) => handleToolHover(tool, position, server.id)}
                />
              ))}

              {/* 空状态 */}
              {servers.length === 0 && !loading && (
                <div className="empty-state">
                  <span className="codicon codicon-server"></span>
                  <p>{t('mcp.noServers')}</p>
                  <p className="hint">{t('mcp.addServerHint')}</p>
                </div>
              )}
            </div>
          ) : null}

          {/* 加载状态 */}
          {loading && servers.length === 0 && (
            <div className="loading-state">
              <span className="codicon codicon-loading codicon-modifier-spin"></span>
              <p>{t('mcp.loading')}</p>
            </div>
          )}
        </div>

        {/* 下方面板：刷新日志 */}
        <RefreshLogsPanel
          logs={refreshLogs}
          t={t}
          onClear={clearLogs}
        />
      </div>

      {/* 弹窗 */}
      {showServerDialog && (
        <McpServerDialog
          server={editingServer}
          existingIds={servers.map(s => s.id)}
          currentProvider={currentProvider}
          onClose={() => {
            setShowServerDialog(false);
            setEditingServer(null);
          }}
          onSave={handleSaveServer}
        />
      )}

      {showPresetDialog && (
        <McpPresetDialog
          onClose={() => setShowPresetDialog(false)}
          onSelect={handleSelectPreset}
        />
      )}

      {showHelpDialog && (
        <McpHelpDialog onClose={() => setShowHelpDialog(false)} />
      )}

      {showConfirmDialog && deletingServer && (
        <McpConfirmDialog
          title={t('mcp.deleteTitle')}
          message={t('mcp.deleteMessage', { name: deletingServer.name || deletingServer.id })}
          confirmText={t('mcp.deleteConfirm')}
          cancelText={t('mcp.cancel')}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}

      {/* Toast 通知 */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />

      {/* 工具提示浮框 */}
      {hoveredTool && (
        <div
          ref={tooltipRef}
          className="mcp-tool-tooltip"
          style={{
            left: `${Math.min(hoveredTool.position.x, window.innerWidth - 420)}px`,
            top: `${hoveredTool.position.y}px`,
          }}
        >
          <div className="tooltip-header">
            <span className="tooltip-icon">
              <span className="codicon">{getToolIcon(hoveredTool.tool.name)}</span>
            </span>
            <span className="tooltip-name">{hoveredTool.tool.name}</span>
          </div>
          {hoveredTool.tool.description && (
            <div className="tooltip-description">{hoveredTool.tool.description}</div>
          )}
          {hoveredTool.tool.inputSchema && (
            <div className="tooltip-params">
              {renderInputSchema(hoveredTool.tool.inputSchema, t)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 渲染 inputSchema 为参数列表
 */
function renderInputSchema(
  schema: Record<string, unknown> | undefined,
  t: (key: string) => string
): React.ReactElement {
  if (!schema) {
    return <div className="tooltip-no-params">{t('mcp.noParams')}</div>;
  }

  const properties = schema.properties as Record<string, { type?: string; description?: string }> | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties || Object.keys(properties).length === 0) {
    return <div className="tooltip-no-params">{t('mcp.noParams')}</div>;
  }

  return (
    <>
      {Object.entries(properties).map(([paramName, paramDef]) => {
        const isRequired = required.includes(paramName);
        const paramType = paramDef.type || 'unknown';
        const paramDesc = paramDef.description;

        return (
          <div key={paramName} className="tooltip-param">
            <div className="tooltip-param-name">{paramName}</div>
            {paramDesc && <div className="tooltip-param-desc">{paramDesc}</div>}
            <div className="tooltip-param-meta">
              <span className="tooltip-param-type">{paramType}</span>
              <span className={isRequired ? 'tooltip-param-required' : 'tooltip-param-optional'}>
                {isRequired ? t('mcp.required') : t('mcp.optional')}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}
