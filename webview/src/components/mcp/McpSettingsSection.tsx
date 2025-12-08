import { useState, useEffect, useRef } from 'react';
import type { McpServer, McpPreset } from '../../types/mcp';
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
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
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

    // 加载服务器
    loadServers();

    // 点击外部关闭下拉菜单
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('click', handleClickOutside);

    return () => {
      window.updateMcpServers = undefined;
      document.removeEventListener('click', handleClickOutside);
    };
  }, []);

  const loadServers = () => {
    setLoading(true);
    sendToJava('get_mcp_servers', {});
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
      addToast(`已删除 ${deletingServer.name || deletingServer.id}`, 'success');

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
    // 轻提示：MCP 市场功能暂未实现
    alert('MCP 市场功能暂未实现，敬请期待');
  };

  const handleSaveServer = (server: McpServer) => {
    if (editingServer) {
      // 更新服务器：如果 ID 改变了，需要先删除旧的
      if (editingServer.id !== server.id) {
        // ID 改变了，先删除旧的，再添加新的
        sendToJava('delete_mcp_server', { id: editingServer.id });
        sendToJava('add_mcp_server', server);
        addToast(`已更新 ${server.name || server.id}`, 'success');
      } else {
        // ID 没变，直接更新
        sendToJava('update_mcp_server', server);
        addToast(`已保存 ${server.name || server.id}`, 'success');
      }
    } else {
      // 添加服务器
      sendToJava('add_mcp_server', server);
      addToast(`已添加 ${server.name || server.id}`, 'success');
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
    addToast(`已添加 ${preset.name}`, 'success');

    // 刷新服务器列表
    setTimeout(() => {
      loadServers();
    }, 100);

    setShowPresetDialog(false);
  };

  const handleCopyUrl = async (url: string) => {
    const success = await copyToClipboard(url);
    if (success) {
      addToast('链接已复制，请到浏览器打开', 'success');
    } else {
      addToast('复制失败，请手动复制', 'error');
    }
  };

  return (
    <div className="mcp-settings-section">
      {/* 头部 */}
      <div className="mcp-header">
        <div className="header-left">
          <span className="header-title">MCP 服务器</span>
          <button
            className="help-btn"
            onClick={() => setShowHelpDialog(true)}
            title="什么是 MCP?"
          >
            <span className="codicon codicon-question"></span>
          </button>
        </div>
        <div className="header-right">
          <button
            className="refresh-btn"
            onClick={handleRefresh}
            disabled={loading}
            title="刷新服务器状态"
          >
            <span className={`codicon codicon-refresh ${loading ? 'spinning' : ''}`}></span>
          </button>
          <div className="add-dropdown" ref={dropdownRef}>
            <button className="add-btn" onClick={() => setShowDropdown(!showDropdown)}>
              <span className="codicon codicon-add"></span>
              添加
              <span className="codicon codicon-chevron-down"></span>
            </button>
            {showDropdown && (
              <div className="dropdown-menu">
                <div className="dropdown-item" onClick={handleAddManual}>
                  <span className="codicon codicon-json"></span>
                  手动配置
                </div>
                <div className="dropdown-item" onClick={handleAddFromMarket}>
                  <span className="codicon codicon-extensions"></span>
                  从 MCP市场 添加
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
                  {/* 服务器信息 */}
                  <div className="info-section">
                    {server.description && (
                      <div className="info-row">
                        <span className="info-label">描述:</span>
                        <span className="info-value">{server.description}</span>
                      </div>
                    )}
                    {server.server.command && (
                      <div className="info-row">
                        <span className="info-label">命令:</span>
                        <code className="info-value command">
                          {server.server.command} {(server.server.args || []).join(' ')}
                        </code>
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
                        主页
                      </button>
                    )}
                    {server.docs && (
                      <button
                        className="action-btn"
                        onClick={() => handleCopyUrl(server.docs!)}
                        title="复制文档链接"
                      >
                        <span className="codicon codicon-book"></span>
                        文档
                      </button>
                    )}
                    <button
                      className="action-btn edit-btn"
                      onClick={() => handleEdit(server)}
                      title="编辑配置"
                    >
                      <span className="codicon codicon-edit"></span>
                      编辑
                    </button>
                    <button
                      className="action-btn delete-btn"
                      onClick={() => handleDelete(server)}
                      title="删除服务器"
                    >
                      <span className="codicon codicon-trash"></span>
                      删除
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
              <p>暂无 MCP 服务器</p>
              <p className="hint">点击"添加"按钮添加服务器</p>
            </div>
          )}
        </div>
      ) : null}

      {/* 加载状态 */}
      {loading && servers.length === 0 && (
        <div className="loading-state">
          <span className="codicon codicon-loading codicon-modifier-spin"></span>
          <p>加载中...</p>
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
          title="删除 MCP 服务器"
          message={`确定要删除服务器 "${deletingServer.name || deletingServer.id}" 吗？\n\n此操作无法撤销。`}
          confirmText="删除"
          cancelText="取消"
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}

      {/* Toast 通知 */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
}
