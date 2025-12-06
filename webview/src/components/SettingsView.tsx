import { useState, useEffect } from 'react';
import type { ProviderConfig } from '../types/provider';
import UsageStatisticsSection from './UsageStatisticsSection';
import { McpSettingsSection } from './mcp/McpSettingsSection';
import AlertDialog from './AlertDialog';
import type { AlertType } from './AlertDialog';
import ConfirmDialog from './ConfirmDialog';
import ConfigInfoDisplay, { type ClaudeConfig } from './settings/ConfigInfoDisplay';
import ProviderList from './settings/ProviderList';
import { ToastContainer, type ToastMessage } from './Toast';
import { copyToClipboard } from '../utils/helpers';
import ProviderDialog from './ProviderDialog';

type SettingsTab = 'basic' | 'providers' | 'usage' | 'permissions' | 'mcp' | 'agents' | 'skills' | 'community';

interface SettingsViewProps {
  onClose: () => void;
}

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  } else {
    console.warn('[SettingsView] sendToJava is not available');
  }
};

// 自动折叠阈值（窗口宽度）
const AUTO_COLLAPSE_THRESHOLD = 900;

const SettingsView = ({ onClose }: SettingsViewProps) => {
  const [currentTab, setCurrentTab] = useState<SettingsTab>('basic');
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(false);

  // Claude CLI 当前配置（来自 ~/.claude/settings.json）
  const [claudeConfig, setClaudeConfig] = useState<ClaudeConfig | null>(null);
  const [claudeConfigLoading, setClaudeConfigLoading] = useState(false);

  // 侧边栏响应式状态
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);

  // 计算是否应该折叠：优先使用手动设置，否则根据窗口宽度自动判断
  const isCollapsed = manualCollapsed !== null
      ? manualCollapsed
      : windowWidth < AUTO_COLLAPSE_THRESHOLD;

  // 供应商弹窗状态
  const [providerDialog, setProviderDialog] = useState<{
    isOpen: boolean;
    provider: ProviderConfig | null; // null 表示添加模式
  }>({ isOpen: false, provider: null });

  // 页面内弹窗状态
  const [alertDialog, setAlertDialog] = useState<{
    isOpen: boolean;
    type: AlertType;
    title: string;
    message: string;
  }>({ isOpen: false, type: 'info', title: '', message: '' });

  // 确认删除弹窗状态
  const [deleteConfirm, setDeleteConfirm] = useState<{
    isOpen: boolean;
    provider: ProviderConfig | null;
  }>({ isOpen: false, provider: null });

  // 主题状态
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
	    // 从 localStorage 读取主题设置
	    const savedTheme = localStorage.getItem('theme');
	    return (savedTheme === 'light' || savedTheme === 'dark') ? savedTheme : 'dark';
	  });

	  // Node.js 路径（手动指定时使用）
	  const [nodePath, setNodePath] = useState('');
	  const [savingNodePath, setSavingNodePath] = useState(false);

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

  // 显示页面内弹窗的帮助函数
  const showAlert = (type: AlertType, title: string, message: string) => {
    console.log('[SettingsView] showAlert called:', { type, title, message });
    setAlertDialog({ isOpen: true, type, title, message });
  };

  const closeAlert = () => {
    setAlertDialog({ ...alertDialog, isOpen: false });
  };

  // 显示切换成功弹窗
  const showSwitchSuccess = (message: string) => {
    console.log('[SettingsView] showSwitchSuccess called:', message);
    showAlert('success', '切换成功', message);
  };

	  useEffect(() => {
	    // 设置全局回调
	    window.updateProviders = (jsonStr: string) => {
	      try {
	        const providersList: ProviderConfig[] = JSON.parse(jsonStr);
	        setProviders(providersList);
	        setLoading(false);
	      } catch (error) {
	        console.error('[SettingsView] Failed to parse providers:', error);
	        setLoading(false);
	      }
	    };

	    window.updateActiveProvider = (jsonStr: string) => {
	      try {
	        const activeProvider: ProviderConfig = JSON.parse(jsonStr);
	        if (activeProvider) {
	          // 更新列表中的激活状态
	          setProviders((prev) =>
	              prev.map((p) => ({ ...p, isActive: p.id === activeProvider.id }))
	          );
	        }
	      } catch (error) {
	        console.error('[SettingsView] Failed to parse active provider:', error);
	      }
	    };

	    // Claude CLI 配置回调
	    window.updateCurrentClaudeConfig = (jsonStr: string) => {
	      try {
	        const config: ClaudeConfig = JSON.parse(jsonStr);
	        setClaudeConfig(config);
	        setClaudeConfigLoading(false);
	      } catch (error) {
	        console.error('[SettingsView] Failed to parse claude config:', error);
	        setClaudeConfigLoading(false);
	      }
	    };

	    window.showError = (message: string) => {
	      console.log('[SettingsView] window.showError called:', message);
	      showAlert('error', '操作失败', message);
	      setLoading(false);
	    };

	    window.showSwitchSuccess = (message: string) => {
	      console.log('[SettingsView] window.showSwitchSuccess called:', message);
	      showSwitchSuccess(message);
	    };

	    window.updateNodePath = (path: string) => {
	      console.log('[SettingsView] window.updateNodePath called:', path);
	      setNodePath(path || '');
	      setSavingNodePath(false);
	    };

	    // 加载供应商列表
	    loadProviders();
	    // 加载 Claude CLI 当前配置
	    loadClaudeConfig();
	    // 加载 Node.js 路径
	    sendToJava('get_node_path:');

	    return () => {
	      window.updateProviders = undefined;
	      window.updateActiveProvider = undefined;
	      window.updateCurrentClaudeConfig = undefined;
	      window.showError = undefined;
	      window.showSwitchSuccess = undefined;
	      window.updateNodePath = undefined;
	    };
	  }, []);

  // 监听窗口大小变化
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);

      // 如果窗口大小变化导致应该自动切换状态，重置手动设置
      const shouldAutoCollapse = window.innerWidth < AUTO_COLLAPSE_THRESHOLD;
      if (manualCollapsed !== null && manualCollapsed === shouldAutoCollapse) {
        setManualCollapsed(null);
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [manualCollapsed]);

  // 手动切换侧边栏折叠状态
  const toggleManualCollapse = () => {
    if (manualCollapsed === null) {
      // 如果当前是自动模式，切换到手动模式
      setManualCollapsed(!isCollapsed);
    } else {
      // 如果已经是手动模式，切换状态
      setManualCollapsed(!manualCollapsed);
    }
  };

  // 主题切换处理
  useEffect(() => {
    // 应用主题到 document.documentElement
    document.documentElement.setAttribute('data-theme', theme);
    // 保存到 localStorage
    localStorage.setItem('theme', theme);
  }, [theme]);

  const loadProviders = () => {
    setLoading(true);
    sendToJava('get_providers:');
  };

  const loadClaudeConfig = () => {
    setClaudeConfigLoading(true);
    sendToJava('get_current_claude_config:');
  };
	
	  const handleSaveNodePath = () => {
	    setSavingNodePath(true);
	    const payload = { path: (nodePath || '').trim() };
	    sendToJava(`set_node_path:${JSON.stringify(payload)}`);
	  };

  const handleEditProvider = (provider: ProviderConfig) => {
    setProviderDialog({ isOpen: true, provider });
  };

  const handleAddProvider = () => {
    setProviderDialog({ isOpen: true, provider: null });
  };

  const handleCloseProviderDialog = () => {
    setProviderDialog({ isOpen: false, provider: null });
  };

  const handleSaveProviderFromDialog = (data: {
    providerName: string;
    websiteUrl: string;
    apiKey: string;
    apiUrl: string;
    jsonConfig: string;
  }) => {
    if (!data.providerName) {
      showAlert('warning', '提示', '请输入供应商名称');
      return;
    }

    // 解析 JSON 配置
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(data.jsonConfig || '{}');
    } catch (e) {
      showAlert('error', '错误', '配置 JSON 格式错误，请修正后再保存');
      return;
    }

    const updates = {
      name: data.providerName,
      websiteUrl: data.websiteUrl,
      settingsConfig: parsedConfig,
    };

    const isAdding = !providerDialog.provider;

    if (isAdding) {
      // 添加新供应商
      const newProvider = {
        id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
        ...updates
      };
      sendToJava(`add_provider:${JSON.stringify(newProvider)}`);
      addToast('供应商添加成功', 'success');
    } else {
      // 更新现有供应商
      if (!providerDialog.provider) return;
      const updateData = {
        id: providerDialog.provider.id,
        updates,
      };
      sendToJava(`update_provider:${JSON.stringify(updateData)}`);
      addToast('供应商更新成功', 'success');
    }

    setProviderDialog({ isOpen: false, provider: null });
    setLoading(true);
  };

  const handleSwitchProvider = (id: string) => {
    const data = { id };
    sendToJava(`switch_provider:${JSON.stringify(data)}`);
    setLoading(true);
  };

  const handleDeleteProvider = (provider: ProviderConfig) => {
    console.log('[SettingsView] handleDeleteProvider called:', provider.id, provider.name);

    // 显示确认弹窗（无任何限制）
    setDeleteConfirm({ isOpen: true, provider });
  };

  const confirmDeleteProvider = () => {
    const provider = deleteConfirm.provider;
    if (!provider) return;

    console.log('[SettingsView] confirmDeleteProvider - sending delete_provider:', provider.id);
    const data = { id: provider.id };
    sendToJava(`delete_provider:${JSON.stringify(data)}`);
    addToast('供应商删除成功', 'success');
    setLoading(true);
    setDeleteConfirm({ isOpen: false, provider: null });
  };

  const cancelDeleteProvider = () => {
    setDeleteConfirm({ isOpen: false, provider: null });
  };

  return (
      <div className="settings-page">
        {/* 顶部标题栏 */}
        <div className="settings-header">
          <div className="header-left">
            <button className="back-btn" onClick={onClose}>
              <span className="codicon codicon-arrow-left" />
            </button>
            <h2 className="settings-title">设置</h2>
          </div>
        </div>

        {/* 主体内容 */}
        <div className="settings-main">
          {/* 侧边栏 */}
          <div className={`settings-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
            <div className="sidebar-items">
              <div
                  className={`sidebar-item ${currentTab === 'basic' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('basic')}
                  title={isCollapsed ? '基础配置' : ''}
              >
                <span className="codicon codicon-settings-gear" />
                <span className="sidebar-item-text">基础配置</span>
              </div>
              <div
                  className={`sidebar-item ${currentTab === 'providers' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('providers')}
                  title={isCollapsed ? '供应商管理' : ''}
              >
                <span className="codicon codicon-vm-connect" />
                <span className="sidebar-item-text">供应商管理</span>
              </div>
              <div
                  className={`sidebar-item ${currentTab === 'usage' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('usage')}
                  title={isCollapsed ? '使用统计' : ''}
              >
                <span className="codicon codicon-graph" />
                <span className="sidebar-item-text">使用统计</span>
              </div>
              <div
                  className={`sidebar-item ${currentTab === 'mcp' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('mcp')}
                  title={isCollapsed ? 'MCP服务器' : ''}
              >
                <span className="codicon codicon-server" />
                <span className="sidebar-item-text">MCP服务器</span>
              </div>
              <div
                  className={`sidebar-item warning ${currentTab === 'permissions' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('permissions')}
                  title={isCollapsed ? '权限配置' : ''}
              >
                <span className="codicon codicon-shield" />
                <span className="sidebar-item-text">权限配置</span>
                <span className="codicon codicon-warning" />
              </div>
              <div
                  className={`sidebar-item warning ${currentTab === 'agents' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('agents')}
                  title={isCollapsed ? 'Agents' : ''}
              >
                <span className="codicon codicon-robot" />
                <span className="sidebar-item-text">Agents</span>
                <span className="codicon codicon-warning" />
              </div>
              <div
                  className={`sidebar-item warning ${currentTab === 'skills' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('skills')}
                  title={isCollapsed ? 'Skills' : ''}
              >
                <span className="codicon codicon-book" />
                <span className="sidebar-item-text">Skills</span>
                <span className="codicon codicon-warning" />
              </div>
              <div
                  className={`sidebar-item ${currentTab === 'community' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('community')}
                  title={isCollapsed ? '官方交流群' : ''}
              >
                <span className="codicon codicon-comment-discussion" />
                <span className="sidebar-item-text">官方交流群</span>
              </div>
            </div>

            {/* 折叠按钮 */}
            <div
                className="sidebar-toggle"
                onClick={toggleManualCollapse}
                title={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            >
              <span className={`codicon ${isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-left'}`} />
            </div>
          </div>

          {/* 内容区域 */}
          <div className={`settings-content ${currentTab === 'providers' ? 'provider-settings-content' : ''}`}>
            {/* 基础配置 */}
            {currentTab === 'basic' && (
                <div className="config-section">
                  <h3 className="section-title">基础配置</h3>
                  <p className="section-desc">配置页面主题和 Node.js 运行环境</p>

                  {/* 主题切换 - 现代卡片设计 */}
                  <div style={{ marginBottom: '24px' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '12px'
                    }}>
                      <span className="codicon codicon-symbol-color" style={{
                        fontSize: '16px',
                        color: 'var(--accent-primary)'
                      }} />
                      <span style={{
                        fontSize: '14px',
                        fontWeight: 600,
                        color: 'var(--text-secondary)'
                      }}>
                        界面主题
                      </span>
                    </div>

                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '12px'
                    }}>
                      {/* 亮色主题卡片 */}
                      <div
                          onClick={() => setTheme('light')}
                          style={{
                            padding: '16px',
                            background: 'var(--bg-secondary)',
                            border: `2px solid ${theme === 'light' ? 'var(--accent-primary)' : 'var(--border-secondary)'}`,
                            borderRadius: '8px',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            position: 'relative',
                            boxShadow: theme === 'light' ? '0 0 0 3px rgba(0, 120, 212, 0.1)' : 'none'
                          }}
                      >
                        {theme === 'light' && (
                            <div style={{
                              position: 'absolute',
                              top: '8px',
                              right: '8px',
                              width: '20px',
                              height: '20px',
                              borderRadius: '50%',
                              background: 'var(--accent-primary)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center'
                            }}>
                              <span className="codicon codicon-check" style={{
                                fontSize: '12px',
                                color: '#ffffff'
                              }} />
                            </div>
                        )}

                        <div style={{
                          width: '40px',
                          height: '40px',
                          borderRadius: '8px',
                          background: 'linear-gradient(135deg, #ffffff 0%, #f5f5f5 100%)',
                          border: '1px solid #e0e0e0',
                          marginBottom: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          <span className="codicon codicon-symbol-color" style={{
                            fontSize: '20px',
                            color: '#666666'
                          }} />
                        </div>

                        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                          亮色主题
                        </div>
                        <div style={{
                          fontSize: '11px',
                          color: 'var(--text-tertiary)',
                          lineHeight: '1.4'
                        }}>
                          清爽明亮，适合白天使用
                        </div>
                      </div>

                      {/* 暗色主题卡片 */}
                      <div
                          onClick={() => setTheme('dark')}
                          style={{
                            padding: '16px',
                            background: 'var(--bg-secondary)',
                            border: `2px solid ${theme === 'dark' ? 'var(--accent-primary)' : 'var(--border-secondary)'}`,
                            borderRadius: '8px',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            position: 'relative',
                            boxShadow: theme === 'dark' ? '0 0 0 3px rgba(0, 120, 212, 0.1)' : 'none'
                          }}
                      >
                        {theme === 'dark' && (
                            <div style={{
                              position: 'absolute',
                              top: '8px',
                              right: '8px',
                              width: '20px',
                              height: '20px',
                              borderRadius: '50%',
                              background: 'var(--accent-primary)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center'
                            }}>
                              <span className="codicon codicon-check" style={{
                                fontSize: '12px',
                                color: '#ffffff'
                              }} />
                            </div>
                        )}

                        <div style={{
                          width: '40px',
                          height: '40px',
                          borderRadius: '8px',
                          background: 'linear-gradient(135deg, #2d2d2d 0%, #1e1e1e 100%)',
                          border: '1px solid #404040',
                          marginBottom: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          <span className="codicon codicon-symbol-event" style={{
                            fontSize: '20px',
                            color: '#cccccc'
                          }} />
                        </div>

                        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                          暗色主题
                        </div>
                        <div style={{
                          fontSize: '11px',
                          color: 'var(--text-tertiary)',
                          lineHeight: '1.4'
                        }}>
                          护眼舒适，适合夜间使用
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Node.js 路径配置 */}
                  <div style={{ marginBottom: '24px' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '8px'
                    }}>
                      <span className="codicon codicon-terminal" style={{
                        fontSize: '16px',
                        color: 'var(--accent-primary)'
                      }} />
                      <span style={{
                        fontSize: '14px',
                        fontWeight: 600,
                        color: 'var(--text-secondary)'
                      }}>
                        Node.js 路径
                      </span>
                    </div>
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '8px',
                      alignItems: 'stretch',
                      marginBottom: '4px'
                    }}>
                      <input
                        type="text"
                        className="form-input node-path-input"
                        placeholder="例如 C:\\Program Files\\nodejs\\node.exe 或 /usr/local/bin/node"
                        value={nodePath}
                        onChange={(e) => setNodePath(e.target.value)}
                        style={{
                          flex: '1 1 300px',
                          minWidth: '200px'
                        }}
                      />
                      <button
                        className="btn-secondary"
                        onClick={handleSaveNodePath}
                        disabled={savingNodePath}
                        style={{
                          flex: '0 0 auto',
                          minWidth: '80px'
                        }}
                      >
                        {savingNodePath && (
                          <span
                            className="codicon codicon-loading codicon-modifier-spin"
                            style={{ marginRight: 4 }}
                          />
                        )}
                        保存
                      </button>
                    </div>
                    <small className="form-hint">
                      <span
                        className="codicon codicon-info"
                        style={{ fontSize: '12px', marginRight: '4px' }}
                      />
                      在终端中运行 <code>node -p &quot;process.execPath&quot;</code> 获取实际的 Node.js 可执行文件路径。
                      为空时插件会自动尝试检测 Node.js。
                    </small>
                  </div>
                </div>
            )}

            {/* 供应商管理 */}
            {currentTab === 'providers' && (
                <div className="config-section provider-config-section" style={{ minWidth: '400px' }}>
                  <h3 className="section-title">供应商管理</h3>
                  <p className="section-desc">管理 Claude API 供应商配置，切换不同的 API 服务提供商</p>

                  {/* 当前 Claude CLI 配置信息展示 */}
                  <div style={{ marginTop: '20px', marginBottom: '24px' }}>
                    <ConfigInfoDisplay
                      config={claudeConfig}
                      loading={claudeConfigLoading}
                      providers={providers.map(p => ({ id: p.id, name: p.name, isActive: p.isActive }))}
                      onSwitchProvider={handleSwitchProvider}
                      addToast={addToast}
                    />
                  </div>

                  {loading && (
                      <div className="temp-notice">
                        <span className="codicon codicon-loading codicon-modifier-spin" />
                        <p>加载中...</p>
                      </div>
                  )}

                  {!loading && (
                      <ProviderList
                        providers={providers}
                        onAdd={handleAddProvider}
                        onEdit={handleEditProvider}
                        onDelete={handleDeleteProvider}
                        onSwitch={handleSwitchProvider}
                        addToast={addToast}
                        emptyState={
                          <>
                            <span className="codicon codicon-info" />
                            <p>暂无供应商配置</p>
                          </>
                        }
                      />
                  )}

                </div>
            )}

            {/* 使用统计 */}
            {currentTab === 'usage' && (
                <div className="config-section usage-section">
                  <h3 className="section-title">使用统计</h3>
                  <p className="section-desc">查看您的 Token 消耗、费用统计和使用趋势分析</p>
                  <UsageStatisticsSection />
                </div>
            )}

            {/* 权限配置 */}
            {currentTab === 'permissions' && (
                <div className="config-section">
                  <h3 className="section-title">权限配置</h3>
                  <p className="section-desc">管理 Claude Code 的文件访问和操作权限</p>
                  <div className="temp-notice">
                    <span className="codicon codicon-shield" />
                    <p>权限配置功能即将推出...</p>
                  </div>
                </div>
            )}

            {/* MCP服务器 */}
            {currentTab === 'mcp' && (
                <div className="config-section">
                  <h3 className="section-title">MCP服务器</h3>
                  <p className="section-desc">配置和管理 Model Context Protocol 服务器</p>
                  <McpSettingsSection />
                </div>
            )}

            {/* Agents */}
            {currentTab === 'agents' && (
                <div className="config-section">
                  <h3 className="section-title">Agents</h3>
                  <p className="section-desc">管理和配置AI代理</p>
                  <div className="temp-notice">
                    <span className="codicon codicon-robot" />
                    <p>Agents配置功能即将推出...</p>
                  </div>
                </div>
            )}

            {/* Skills */}
            {currentTab === 'skills' && (
                <div className="config-section">
                  <h3 className="section-title">Skills</h3>
                  <p className="section-desc">管理和配置技能模块</p>
                  <div className="temp-notice">
                    <span className="codicon codicon-book" />
                    <p>Skills配置功能即将推出...</p>
                  </div>
                </div>
            )}

            {/* 官方交流群 */}
            {currentTab === 'community' && (
                <div className="config-section community-section">
                  <h3 className="section-title">官方交流群</h3>
                  <p className="section-desc">扫描下方二维码加入官方微信交流群，获取最新资讯和技术支持</p>

                  <div className="qrcode-container">
                    <div className="qrcode-wrapper">
                      <img
                          src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/vscode/wxq.png"
                          alt="官方微信交流群二维码"
                          className="qrcode-image"
                      />
                      <p className="qrcode-tip">使用微信扫一扫加入交流群</p>
                    </div>
                  </div>
                </div>
            )}
          </div>
        </div>

        {/* 页面内弹窗 */}
        <AlertDialog
            isOpen={alertDialog.isOpen}
            type={alertDialog.type}
            title={alertDialog.title}
            message={alertDialog.message}
            onClose={closeAlert}
        />

        {/* 删除确认弹窗 */}
        <ConfirmDialog
            isOpen={deleteConfirm.isOpen}
            title="确认删除"
            message={`确定要删除供应商"${deleteConfirm.provider?.name || ''}"吗？\n\n此操作无法撤销。`}
            confirmText="删除"
            cancelText="取消"
            onConfirm={confirmDeleteProvider}
            onCancel={cancelDeleteProvider}
        />

        {/* 供应商添加/编辑弹窗 */}
        <ProviderDialog
            isOpen={providerDialog.isOpen}
            provider={providerDialog.provider}
            onClose={handleCloseProviderDialog}
            onSave={handleSaveProviderFromDialog}
            onDelete={handleDeleteProvider}
            canDelete={true}
            copyToClipboard={copyToClipboard}
            addToast={addToast}
        />

        {/* Toast 通知 */}
        <ToastContainer messages={toasts} onDismiss={dismissToast} />
      </div>
  );
};

export default SettingsView;
