import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer, McpPreset, McpServerStatusInfo } from '../../types/mcp';
import { sendToJava } from '../../utils/bridge';
import { McpServerDialog } from './McpServerDialog';
import { McpPresetDialog } from './McpPresetDialog';
import { McpHelpDialog } from './McpHelpDialog';
import { McpConfirmDialog } from './McpConfirmDialog';
import { ToastContainer, type ToastMessage } from '../Toast';
import { copyToClipboard } from '../../utils/helpers';

/**
 * MCP 服务器设置组件
 */
export function McpSettingsSection() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [serverStatus, setServerStatus] = useState<Map<string, McpServerStatusInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 弹窗状态
  const [showServerDialog, setShowServerDialog] = useState(false);
  const [showPresetDialog, setShowPresetDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
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
    // 注册回调
    window.updateMcpServers = (jsonStr: string) => {
      try {
        const serverList: McpServer[] = JSON.parse(jsonStr);
        setServers(serverList);
        setLoading(false);
        console.log('[McpSettings] Loaded servers:', serverList);
      } catch (error) {
        console.error('[McpSettings] Failed to parse servers:', error);
        setLoading(false);
      }
    };

    // 注册状态回调
    window.updateMcpServerStatus = (jsonStr: string) => {
      try {
        const statusList: McpServerStatusInfo[] = JSON.parse(jsonStr);
        const statusMap = new Map<string, McpServerStatusInfo>();
        statusList.forEach((status) => {
          statusMap.set(status.name, status);
        });
        setServerStatus(statusMap);
        setStatusLoading(false);
        console.log('[McpSettings] Loaded server status:', statusList);
      } catch (error) {
        console.error('[McpSettings] Failed to parse server status:', error);
        setStatusLoading(false);
      }
    };

    // 加载服务器
    loadServers();
    loadServerStatus();

    // 点击外部关闭下拉菜单
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('click', handleClickOutside);

    return () => {
      window.updateMcpServers = undefined;
      window.updateMcpServerStatus = undefined;
      document.removeEventListener('click', handleClickOutside);
    };
  }, []);

  const loadServers = () => {
    setLoading(true);
    sendToJava('get_mcp_servers', {});
  };

  const loadServerStatus = () => {
    setStatusLoading(true);
    sendToJava('get_mcp_server_status', {});
  };

  const getServerStatusInfo = (server: McpServer): McpServerStatusInfo | undefined => {
    return serverStatus.get(server.id) || serverStatus.get(server.name || '');
  };

  const getStatusIcon = (status: McpServerStatusInfo['status'] | undefined): string => {
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

  const getStatusColor = (status: McpServerStatusInfo['status'] | undefined): string => {
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

  const getStatusText = (status: McpServerStatusInfo['status'] | undefined): string => {
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
    return server.apps?.claude !== false;
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

  // TODO: 启用/禁用开关功能 - 暂时注释掉，后续再加回
  // const handleToggleServer = (server: McpServer, enabled: boolean) => {
  //   const updatedServer: McpServer = {
  //     ...server,
  //     enabled,
  //     apps: {
  //       claude: enabled,
  //       codex: server.apps?.codex ?? false,
  //       gemini: server.apps?.gemini ?? false,
  //     }
  //   };
  //
  //   sendToJava('update_mcp_server', updatedServer);
  //
  //   // 显示Toast提示
  //   addToast(enabled ? `已启用 ${server.name || server.id}` : `已禁用 ${server.name || server.id}`, 'success');
  //
  //   // 刷新服务器列表以显示最新状态
  //   setTimeout(() => {
  //     loadServers();
  //   }, 100);
  // };

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
      sendToJava('delete_mcp_server', { id: deletingServer.id });
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
        sendToJava('delete_mcp_server', { id: editingServer.id });
        sendToJava('add_mcp_server', server);
        addToast(`${t('mcp.updated')} ${server.name || server.id}`, 'success');
      } else {
        // ID 没变，直接更新
        sendToJava('update_mcp_server', server);
        addToast(`${t('mcp.saved')} ${server.name || server.id}`, 'success');
      }
    } else {
      // 添加服务器
      sendToJava('add_mcp_server', server);
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
        claude: true,
        codex: false,
        gemini: false,
      },
      homepage: preset.homepage,
      docs: preset.docs,
      enabled: true,
    };
    sendToJava('add_mcp_server', server);
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
                        style={{ color: getStatusColor(status) }}
                        title={getStatusText(status)}
                      >
                        <span className={`codicon ${getStatusIcon(status)}`}></span>
                      </span>
                    );
                  })()}
                </div>
                <div className="header-right-section" onClick={(e) => e.stopPropagation()}>
                  {/* TODO: 启用/禁用开关 - 暂时隐藏，后续再加回 */}
                  {/* <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={isServerEnabled(server)}
                      onChange={(e) => handleToggleServer(server, e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label> */}
                </div>
              </div>

              {/* 展开内容 */}
              {expandedServers.has(server.id) && (
                <div className="card-content">
                  {/* 连接状态信息 */}
                  {(() => {
                    const statusInfo = getServerStatusInfo(server);
                    if (statusInfo) {
                      return (
                        <div className="status-section">
                          <div className="info-row">
                            <span className="info-label">{t('mcp.connectionStatus')}:</span>
                            <span
                              className="info-value status-value"
                              style={{ color: getStatusColor(statusInfo.status) }}
                            >
                              <span className={`codicon ${getStatusIcon(statusInfo.status)}`}></span>
                              {' '}{getStatusText(statusInfo.status)}
                            </span>
                          </div>
                          {statusInfo.serverInfo && (
                            <div className="info-row">
                              <span className="info-label">{t('mcp.serverVersion')}:</span>
                              <span className="info-value">
                                {statusInfo.serverInfo.name} v{statusInfo.serverInfo.version}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    }
                    return null;
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
                        title="复制主页链接"
                      >
                        <span className="codicon codicon-home"></span>
                        {t('mcp.homepage')}
                      </button>
                    )}
                    {server.docs && (
                      <button
                        className="action-btn"
                        onClick={() => handleCopyUrl(server.docs!)}
                        title="复制文档链接"
                      >
                        <span className="codicon codicon-book"></span>
                        {t('mcp.docs')}
                      </button>
                    )}
                    <button
                      className="action-btn edit-btn"
                      onClick={() => handleEdit(server)}
                      title="编辑配置"
                    >
                      <span className="codicon codicon-edit"></span>
                      {t('mcp.edit')}
                    </button>
                    <button
                      className="action-btn delete-btn"
                      onClick={() => handleDelete(server)}
                      title="删除服务器"
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
    </div>
  );
}
