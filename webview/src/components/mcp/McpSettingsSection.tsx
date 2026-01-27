import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer, McpPreset, McpServerStatusInfo, McpLogEntry } from '../../types/mcp';
import { sendToJava } from '../../utils/bridge';
import { McpServerDialog } from './McpServerDialog';
import { McpPresetDialog } from './McpPresetDialog';
import { McpHelpDialog } from './McpHelpDialog';
import { McpConfirmDialog } from './McpConfirmDialog';
import { McpLogDialog } from './McpLogDialog';
import { ToastContainer, type ToastMessage } from '../Toast';
import { copyToClipboard } from '../../utils/copyUtils';

interface McpSettingsSectionProps {
  currentProvider?: 'claude' | 'codex' | string;
}

/**
 * MCP 服务器设置组件
 * Supports both Claude and Codex providers
 */
export function McpSettingsSection({ currentProvider = 'claude' }: McpSettingsSectionProps) {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';

  // Generate message type prefix based on provider
  const messagePrefix = useMemo(() => (isCodexMode ? 'codex_' : ''), [isCodexMode]);

  const [servers, setServers] = useState<McpServer[]>([]);
  const [serverStatus, setServerStatus] = useState<Map<string, McpServerStatusInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const refreshTimersRef = useRef<number[]>([]);

  // 弹窗状态
  const [showServerDialog, setShowServerDialog] = useState(false);
  const [showPresetDialog, setShowPresetDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showLogDialog, setShowLogDialog] = useState(false);
  const [logs, setLogs] = useState<McpLogEntry[]>([]);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [deletingServer, setDeletingServer] = useState<McpServer | null>(null);

  // Toast 状态管理
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Toast 辅助函数
  const addToast = (message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  /**
   * 添加日志条目
   * @param serverName - 服务器名称
   * @param level - 日志级别
   * @param message - 日志消息
   */
  const addLog = useCallback((serverName: string, level: McpLogEntry['level'], message: string) => {
    const entry: McpLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      timestamp: new Date(),
      serverName,
      level,
      message,
    };
    setLogs((prev) => [...prev.slice(-99), entry]); // Keep last 100 logs
  }, []);

  /**
   * 清空所有日志
   */
  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // 服务器图标颜色
  const iconColors = [
    '#3B82F6', // blue
    '#10B981', // green
    '#8B5CF6', // purple
    '#F59E0B', // amber
    '#EF4444', // red
    '#EC4899', // pink
    '#06B6D4', // cyan
    '#6366F1', // indigo
  ];

  // 初始化
  useEffect(() => {
    const clearRefreshTimers = () => {
      refreshTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      refreshTimersRef.current = [];
    };

    const scheduleRefresh = (enabled: boolean) => {
      clearRefreshTimers();

      const serverRefreshDelays = enabled ? [200, 1000] : [200];
      // Codex mode: no status refresh (Codex SDK doesn't support real-time status)
      const statusRefreshDelays = isCodexMode ? [] : (enabled ? [400, 1500, 3500, 7000, 12000] : [400]);

      serverRefreshDelays.forEach((delay) => {
        refreshTimersRef.current.push(window.setTimeout(() => loadServers(), delay));
      });
      statusRefreshDelays.forEach((delay) => {
        refreshTimersRef.current.push(window.setTimeout(() => loadServerStatus(), delay));
      });
    };

    // Server list callback handler
    const handleServerListUpdate = (jsonStr: string) => {
      try {
        const serverList: McpServer[] = JSON.parse(jsonStr);
        setServers(serverList);
        setLoading(false);
      } catch (error) {
        setLoading(false);
      }
    };

    // Server status callback handler (Claude only)
    const handleServerStatusUpdate = (jsonStr: string) => {
      try {
        const statusList: McpServerStatusInfo[] = JSON.parse(jsonStr);
        const statusMap = new Map<string, McpServerStatusInfo>();
        statusList.forEach((status) => {
          statusMap.set(status.name, status);
          // Add log entries for status updates
          if (status.status === 'connected') {
            const version = status.serverInfo ? ` (v${status.serverInfo.version})` : '';
            addLog(status.name, 'success', `${t('mcp.logs.connected')}${version}`);
          } else if (status.status === 'failed') {
            const errorMsg = status.error || t('mcp.logs.unknownError');
            addLog(status.name, 'error', `${t('mcp.logs.failed')}: ${errorMsg}`);
          } else if (status.status === 'needs-auth') {
            addLog(status.name, 'warn', t('mcp.logs.needsAuth'));
          }
        });
        setServerStatus(statusMap);
        setStatusLoading(false);
      } catch (error) {
        setStatusLoading(false);
      }
    };

    // Server toggled callback handler
    const handleServerToggled = (jsonStr: string) => {
      try {
        const toggledServer: McpServer = JSON.parse(jsonStr);
        scheduleRefresh(isServerEnabled(toggledServer));
      } catch (error) {
        console.error('[McpSettings] Failed to parse toggled server:', error);
      }
    };

    // Register callbacks based on provider
    if (isCodexMode) {
      window.updateCodexMcpServers = handleServerListUpdate;
      window.codexMcpServerToggled = handleServerToggled;
      window.codexMcpServerAdded = () => loadServers();
      window.codexMcpServerUpdated = () => loadServers();
      window.codexMcpServerDeleted = () => loadServers();
    } else {
      window.updateMcpServers = handleServerListUpdate;
      window.updateMcpServerStatus = handleServerStatusUpdate;
      window.mcpServerToggled = handleServerToggled;
    }

    // 加载服务器
    loadServers();
    if (!isCodexMode) {
      loadServerStatus();
    }

    // 点击外部关闭下拉菜单
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('click', handleClickOutside);

    return () => {
      clearRefreshTimers();
      // Cleanup callbacks
      if (isCodexMode) {
        window.updateCodexMcpServers = undefined;
        window.codexMcpServerToggled = undefined;
        window.codexMcpServerAdded = undefined;
        window.codexMcpServerUpdated = undefined;
        window.codexMcpServerDeleted = undefined;
      } else {
        window.updateMcpServers = undefined;
        window.updateMcpServerStatus = undefined;
        window.mcpServerToggled = undefined;
      }
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isCodexMode, addLog, t]);

  const loadServers = () => {
    setLoading(true);
    sendToJava(`get_${messagePrefix}mcp_servers`, {});
  };

  const loadServerStatus = () => {
    // Codex doesn't support real-time MCP status query
    if (isCodexMode) {
      setStatusLoading(false);
      return;
    }
    setStatusLoading(true);
    sendToJava('get_mcp_server_status', {});
  };

  const getServerStatusInfo = (server: McpServer): McpServerStatusInfo | undefined => {
    // 尝试多种方式匹配服务器状态
    // 1. 尝试用 id 匹配
    let statusInfo = serverStatus.get(server.id);
    if (statusInfo) return statusInfo;

    // 2. 尝试用 name 匹配
    if (server.name) {
      statusInfo = serverStatus.get(server.name);
      if (statusInfo) return statusInfo;
    }

    // 3. 遍历所有状态，尝试模糊匹配
    for (const [key, value] of serverStatus.entries()) {
      // 不区分大小写比较
      if (key.toLowerCase() === server.id.toLowerCase() ||
          (server.name && key.toLowerCase() === server.name.toLowerCase())) {
        return value;
      }
    }

    return undefined;
  };

  const getStatusIcon = (server: McpServer, status: McpServerStatusInfo['status'] | undefined): string => {
    // 如果服务器被禁用，显示禁用图标
    if (!isServerEnabled(server)) {
      return 'codicon-circle-slash';
    }

    switch (status) {
      case 'connected':
        return 'codicon-check';
      case 'failed':
        return 'codicon-error';
      case 'needs-auth':
        return 'codicon-key';
      case 'pending':
        return 'codicon-loading codicon-modifier-spin';
      default:
        return 'codicon-circle-outline';
    }
  };

  const getStatusColor = (server: McpServer, status: McpServerStatusInfo['status'] | undefined): string => {
    // 如果服务器被禁用，显示灰色
    if (!isServerEnabled(server)) {
      return '#9CA3AF';
    }

    switch (status) {
      case 'connected':
        return '#10B981';
      case 'failed':
        return '#EF4444';
      case 'needs-auth':
        return '#F59E0B';
      case 'pending':
        return '#6B7280';
      default:
        return '#6B7280';
    }
  };

  const getStatusText = (server: McpServer, status: McpServerStatusInfo['status'] | undefined): string => {
    // 如果服务器被禁用，显示"已禁用"
    if (!isServerEnabled(server)) {
      return t('mcp.disabled');
    }

    switch (status) {
      case 'connected':
        return t('mcp.statusConnected');
      case 'failed':
        return t('mcp.statusFailed');
      case 'needs-auth':
        return t('mcp.statusNeedsAuth');
      case 'pending':
        return t('mcp.statusPending');
      default:
        return t('mcp.statusUnknown');
    }
  };

  const getIconColor = (serverId: string): string => {
    let hash = 0;
    for (let i = 0; i < serverId.length; i++) {
      hash = serverId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return iconColors[Math.abs(hash) % iconColors.length];
  };

  const getServerInitial = (server: McpServer): string => {
    const name = server.name || server.id;
    return name.charAt(0).toUpperCase();
  };

  const isServerEnabled = (server: McpServer): boolean => {
    if (server.enabled !== undefined) {
      return server.enabled;
    }
    // Check provider-specific apps field
    return isCodexMode
      ? server.apps?.codex !== false
      : server.apps?.claude !== false;
  };

  const toggleExpand = (serverId: string) => {
    const newExpanded = new Set(expandedServers);
    if (newExpanded.has(serverId)) {
      newExpanded.delete(serverId);
    } else {
      newExpanded.add(serverId);
    }
    setExpandedServers(newExpanded);
  };

  const handleRefresh = () => {
    loadServers();
    loadServerStatus();
  };

  const handleToggleServer = (server: McpServer, enabled: boolean) => {
    // Set apps based on current provider mode
    const updatedServer: McpServer = {
      ...server,
      enabled,
      apps: {
        claude: isCodexMode ? (server.apps?.claude ?? false) : enabled,
        codex: isCodexMode ? enabled : (server.apps?.codex ?? false),
        gemini: server.apps?.gemini ?? false,
      }
    };

    sendToJava(`toggle_${messagePrefix}mcp_server`, updatedServer);

    // 显示Toast提示
    addToast(enabled ? `${t('mcp.enabled')} ${server.name || server.id}` : `${t('mcp.disabled')} ${server.name || server.id}`, 'success');

    if (enabled) {
      setServerStatus((prev) => {
        const next = new Map(prev);
        const pendingById: McpServerStatusInfo = { name: server.id, status: 'pending' };
        next.set(server.id, pendingById);
        if (server.name) {
          next.set(server.name, { name: server.name, status: 'pending' });
        }
        return next;
      });
    }

    loadServers();
    loadServerStatus();
  };

  const handleEdit = (server: McpServer) => {
    setEditingServer(server);
    setShowServerDialog(true);
  };

  const handleDelete = (server: McpServer) => {
    setDeletingServer(server);
    setShowConfirmDialog(true);
  };

  const confirmDelete = () => {
    if (deletingServer) {
      sendToJava(`delete_${messagePrefix}mcp_server`, { id: deletingServer.id });
      addToast(`${t('mcp.deleted')} ${deletingServer.name || deletingServer.id}`, 'success');

      // 刷新服务器列表
      setTimeout(() => {
        loadServers();
      }, 100);
    }
    setShowConfirmDialog(false);
    setDeletingServer(null);
  };

  const cancelDelete = () => {
    setShowConfirmDialog(false);
    setDeletingServer(null);
  };

  const handleAddManual = () => {
    setShowDropdown(false);
    setEditingServer(null);
    setShowServerDialog(true);
  };

  const handleAddFromMarket = () => {
    setShowDropdown(false);
    alert(t('mcp.marketComingSoon'));
  };

  const handleSaveServer = (server: McpServer) => {
    if (editingServer) {
      // 更新服务器：如果 ID 改变了，需要先删除旧的
      if (editingServer.id !== server.id) {
        // ID 改变了，先删除旧的，再添加新的
        sendToJava(`delete_${messagePrefix}mcp_server`, { id: editingServer.id });
        sendToJava(`add_${messagePrefix}mcp_server`, server);
        addToast(`${t('mcp.updated')} ${server.name || server.id}`, 'success');
      } else {
        // ID 没变，直接更新
        sendToJava(`update_${messagePrefix}mcp_server`, server);
        addToast(`${t('mcp.saved')} ${server.name || server.id}`, 'success');
      }
    } else {
      // 添加服务器
      sendToJava(`add_${messagePrefix}mcp_server`, server);
      addToast(`${t('mcp.added')} ${server.name || server.id}`, 'success');
    }

    // 刷新服务器列表
    setTimeout(() => {
      loadServers();
    }, 100);

    setShowServerDialog(false);
    setEditingServer(null);
  };

  const handleSelectPreset = (preset: McpPreset) => {
    // 从预设创建服务器
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

    // 刷新服务器列表
    setTimeout(() => {
      loadServers();
    }, 100);

    setShowPresetDialog(false);
  };

  const handleCopyUrl = async (url: string) => {
    const success = await copyToClipboard(url);
    if (success) {
      addToast(t('mcp.linkCopied'), 'success');
    } else {
      addToast(t('mcp.copyFailed'), 'error');
    }
  };

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
            className="log-btn"
            onClick={() => setShowLogDialog(true)}
            title={t('mcp.logs.title')}
          >
            <span className="codicon codicon-output"></span>
            {logs.length > 0 && <span className="log-badge">{logs.length}</span>}
          </button>
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

      {/* 服务器列表 */}
      {!loading || servers.length > 0 ? (
        <div className="server-list">
          {servers.map(server => (
            <div
              key={server.id}
              className={`server-card ${expandedServers.has(server.id) ? 'expanded' : ''} ${!isServerEnabled(server) ? 'disabled' : ''}`}
            >
              {/* 卡片头部 */}
              <div className="card-header" onClick={() => toggleExpand(server.id)}>
                <div className="header-left-section">
                  <span className={`expand-icon codicon ${expandedServers.has(server.id) ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></span>
                  <div className="server-icon" style={{ background: getIconColor(server.id) }}>
                    {getServerInitial(server)}
                  </div>
                  <span className="server-name">{server.name || server.id}</span>
                  {/* 连接状态指示器 */}
                  {(() => {
                    const statusInfo = getServerStatusInfo(server);
                    const status = statusInfo?.status;
                    return (
                      <span
                        className="status-indicator"
                        style={{ color: getStatusColor(server, status) }}
                        title={getStatusText(server, status)}
                      >
                        <span className={`codicon ${getStatusIcon(server, status)}`}></span>
                      </span>
                    );
                  })()}
                </div>
                <div className="header-right-section" onClick={(e) => e.stopPropagation()}>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={isServerEnabled(server)}
                      onChange={(e) => handleToggleServer(server, e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
              </div>

              {/* 展开内容 */}
              {expandedServers.has(server.id) && (
                <div className="card-content">
                  {/* 连接状态信息 */}
                  {(() => {
                    const statusInfo = getServerStatusInfo(server);
                    // 对于已启用的服务器，始终显示状态信息（即使是未知状态）
                    // 对于已禁用的服务器，也显示禁用状态
                    return (
                      <div className="status-section">
                        <div className="info-row">
                          <span className="info-label">{t('mcp.connectionStatus')}:</span>
                          <span
                            className="info-value status-value"
                            style={{ color: getStatusColor(server, statusInfo?.status) }}
                          >
                            <span className={`codicon ${getStatusIcon(server, statusInfo?.status)}`}></span>
                            {' '}{getStatusText(server, statusInfo?.status)}
                          </span>
                        </div>
                        {/* 显示错误详情 */}
                        {statusInfo?.error && statusInfo.status === 'failed' && (
                          <div className="info-row error-row">
                            <span className="info-label">{t('mcp.errorDetails')}:</span>
                            <span className="info-value error-value">{statusInfo.error}</span>
                          </div>
                        )}
                        {statusInfo?.serverInfo && (
                          <div className="info-row">
                            <span className="info-label">{t('mcp.serverVersion')}:</span>
                            <span className="info-value">
                              {statusInfo.serverInfo.name} v{statusInfo.serverInfo.version}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}

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
                        onClick={() => handleCopyUrl(server.homepage!)}
                        title={t('chat.copyHomepageLink')}
                      >
                        <span className="codicon codicon-home"></span>
                        {t('mcp.homepage')}
                      </button>
                    )}
                    {server.docs && (
                      <button
                        className="action-btn"
                        onClick={() => handleCopyUrl(server.docs!)}
                        title={t('chat.copyDocsLink')}
                      >
                        <span className="codicon codicon-book"></span>
                        {t('mcp.docs')}
                      </button>
                    )}
                    <button
                      className="action-btn edit-btn"
                      onClick={() => handleEdit(server)}
                      title={t('chat.editConfig')}
                    >
                      <span className="codicon codicon-edit"></span>
                      {t('mcp.edit')}
                    </button>
                    <button
                      className="action-btn delete-btn"
                      onClick={() => handleDelete(server)}
                      title={t('chat.deleteServer')}
                    >
                      <span className="codicon codicon-trash"></span>
                      {t('mcp.delete')}
                    </button>
                  </div>
                </div>
              )}
            </div>
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

      {showLogDialog && (
        <McpLogDialog
          logs={logs}
          onClose={() => setShowLogDialog(false)}
          onClear={clearLogs}
        />
      )}

      {/* Toast 通知 */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
}
