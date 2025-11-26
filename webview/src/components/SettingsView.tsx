import { useState, useEffect } from 'react';
import type { ProviderConfig } from '../types/provider';
import UsageStatisticsSection from './UsageStatisticsSection';

type SettingsTab = 'basic' | 'usage' | 'permissions' | 'mcp' | 'agents' | 'skills' | 'community';

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

  // 侧边栏响应式状态
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);

  // 计算是否应该折叠：优先使用手动设置，否则根据窗口宽度自动判断
  const isCollapsed = manualCollapsed !== null
    ? manualCollapsed
    : windowWidth < AUTO_COLLAPSE_THRESHOLD;

  // 编辑/添加表单状态
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [providerName, setProviderName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  
  // UI 状态
  const [showApiKey, setShowApiKey] = useState(false);
  const [jsonConfig, setJsonConfig] = useState('');
  const [jsonError, setJsonError] = useState('');

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

    window.showError = (message: string) => {
      alert(message);
      setLoading(false);
    };

    // 加载供应商列表
    loadProviders();

    return () => {
      window.updateProviders = undefined;
      window.updateActiveProvider = undefined;
      window.showError = undefined;
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

  const loadProviders = () => {
    setLoading(true);
    sendToJava('get_providers:');
  };

  const handleEditProvider = (provider: ProviderConfig) => {
    setEditingProvider(provider);
    setIsAdding(false);
    setProviderName(provider.name || '');
    setWebsiteUrl(provider.websiteUrl || '');
    setApiKey(provider.settingsConfig?.env?.ANTHROPIC_AUTH_TOKEN || '');
    setApiUrl(provider.settingsConfig?.env?.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
    setShowApiKey(false);
    setJsonError('');
    
    // Initialize JSON Config
    const config = {
      env: {
        ANTHROPIC_AUTH_TOKEN: provider.settingsConfig?.env?.ANTHROPIC_AUTH_TOKEN || '',
        ANTHROPIC_BASE_URL: provider.settingsConfig?.env?.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      }
    };
    setJsonConfig(JSON.stringify(config, null, 2));
  };

  const handleAddProvider = () => {
    setIsAdding(true);
    setEditingProvider(null);
    setProviderName('');
    setWebsiteUrl('');
    setApiKey('');
    setApiUrl('');
    setShowApiKey(false);
    setJsonError('');
    
    // Initialize JSON Config
    const config = {
      env: {
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: '',
      }
    };
    setJsonConfig(JSON.stringify(config, null, 2));
  };

  const handleSaveProvider = () => {
    if (!editingProvider && !isAdding) return;
    
    // 检查 JSON 格式
    if (jsonError) {
      alert('配置 JSON 格式错误，请修正后再保存');
      return;
    }

    if (!providerName) {
        alert('请输入供应商名称');
        return;
    }

    const updates = {
      name: providerName,
      websiteUrl: websiteUrl,
      settingsConfig: {
        env: {
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_BASE_URL: apiUrl,
        },
      },
    };

    if (isAdding) {
        // 添加新供应商
        const newProvider = {
            id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
            ...updates
        };
        sendToJava(`add_provider:${JSON.stringify(newProvider)}`);
    } else if (editingProvider) {
        // 更新现有供应商
        const data = {
          id: editingProvider.id,
          updates,
        };
        sendToJava(`update_provider:${JSON.stringify(data)}`);
    }

    setEditingProvider(null);
    setIsAdding(false);
    setLoading(true);
  };

  const handleCancelEdit = () => {
    setEditingProvider(null);
    setIsAdding(false);
    setProviderName('');
    setWebsiteUrl('');
    setApiKey('');
    setApiUrl('');
    setJsonConfig('');
    setJsonError('');
  };

  const handleSwitchProvider = (id: string) => {
    const data = { id };
    sendToJava(`switch_provider:${JSON.stringify(data)}`);
    setLoading(true);
  };

  const handleDeleteProvider = (provider: ProviderConfig) => {
    if (providers.length === 1) {
      alert('至少需要保留一个供应商配置');
      return;
    }

    if (provider.isActive) {
      alert('无法删除当前使用的供应商。请先切换到其他供应商后再删除。');
      return;
    }

    if (!confirm(`确定要删除供应商"${provider.name}"吗？\n\n此操作无法撤销。`)) {
      return;
    }

    const data = { id: provider.id };
    sendToJava(`delete_provider:${JSON.stringify(data)}`);
    setLoading(true);
  };

  // Field Change Handlers
  const updateJsonFromFields = (newApiKey: string, newApiUrl: string) => {
    try {
      const config = JSON.parse(jsonConfig || '{}');
      if (!config.env) config.env = {};
      config.env.ANTHROPIC_AUTH_TOKEN = newApiKey;
      config.env.ANTHROPIC_BASE_URL = newApiUrl;
      setJsonConfig(JSON.stringify(config, null, 2));
      setJsonError('');
    } catch (e) {
      // If JSON is currently invalid, we can't verify/update safely, 
      // but we could just reconstruct it if we wanted strict sync.
      // For now, we'll just leave it alone if it's broken.
    }
  };

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setApiKey(newValue);
    updateJsonFromFields(newValue, apiUrl);
  };

  const handleApiUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setApiUrl(newValue);
    updateJsonFromFields(apiKey, newValue);
  };

  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setJsonConfig(newValue);
    setJsonError('');
    
    try {
      const config = JSON.parse(newValue);
      if (config && typeof config === 'object') {
        if (config.env) {
          if (config.env.ANTHROPIC_AUTH_TOKEN !== undefined) {
            setApiKey(config.env.ANTHROPIC_AUTH_TOKEN);
          }
          if (config.env.ANTHROPIC_BASE_URL !== undefined) {
            setApiUrl(config.env.ANTHROPIC_BASE_URL);
          }
        }
      }
    } catch (err) {
      if (err instanceof Error) {
        setJsonError(err.message);
      } else {
        setJsonError('Invalid JSON');
      }
    }
  };

  const isValidUrl = (url: string) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
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
              className={`sidebar-item ${currentTab === 'usage' ? 'active' : ''}`}
              onClick={() => setCurrentTab('usage')}
              title={isCollapsed ? '使用统计' : ''}
            >
              <span className="codicon codicon-graph" />
              <span className="sidebar-item-text">使用统计</span>
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
              className={`sidebar-item warning ${currentTab === 'mcp' ? 'active' : ''}`}
              onClick={() => setCurrentTab('mcp')}
              title={isCollapsed ? 'MCP服务器' : ''}
            >
              <span className="codicon codicon-server" />
              <span className="sidebar-item-text">MCP服务器</span>
              <span className="codicon codicon-warning" />
            </div>
            <div
              className={`sidebar-item ${currentTab === 'agents' ? 'active' : ''}`}
              onClick={() => setCurrentTab('agents')}
              title={isCollapsed ? 'Agents' : ''}
            >
              <span className="codicon codicon-robot" />
              <span className="sidebar-item-text">Agents</span>
            </div>
            <div
              className={`sidebar-item ${currentTab === 'skills' ? 'active' : ''}`}
              onClick={() => setCurrentTab('skills')}
              title={isCollapsed ? 'Skills' : ''}
            >
              <span className="codicon codicon-book" />
              <span className="sidebar-item-text">Skills</span>
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
        <div className="settings-content">
          {/* 基础配置 */}
          {currentTab === 'basic' && (
            <div className="config-section">
              <h3 className="section-title">基础配置</h3>
              <p className="section-desc">配置API密钥、模型选择、代理等基础设置</p>

              {loading && (
                <div className="temp-notice">
                  <span className="codicon codicon-loading codicon-modifier-spin" />
                  <p>加载中...</p>
                </div>
              )}

              {!loading && !editingProvider && !isAdding && providers.length === 0 && (
                <div className="temp-notice">
                  <span className="codicon codicon-info" />
                  <p>暂无供应商配置</p>
                  <button 
                    className="btn-primary" 
                    style={{ marginTop: '16px' }}
                    onClick={handleAddProvider}
                  >
                    <span className="codicon codicon-add" />
                    添加供应商
                  </button>
                </div>
              )}

              {!loading && !editingProvider && !isAdding && providers.length > 0 && (
                <div className="provider-list-container">
                  <div className="provider-list-header">
                    <div>
                        <h4>供应商列表</h4>
                        <small>当前共 {providers.length} 个供应商</small>
                    </div>
                    <button className="btn-small btn-primary" onClick={handleAddProvider}>
                        <span className="codicon codicon-add" />
                        添加
                    </button>
                  </div>

                  {providers.map((provider) => (
                    <div key={provider.id} className={`provider-card ${provider.isActive ? 'active' : ''}`}>
                      <div className="provider-card-header">
                        <div className="provider-info">
                          <h5 className="provider-name">
                            {provider.name}
                            {provider.isActive && <span className="active-badge">使用中</span>}
                          </h5>
                          {provider.websiteUrl && (
                            <a
                              href={provider.websiteUrl}
                              className="provider-url"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {provider.websiteUrl}
                            </a>
                          )}
                        </div>
                        <div className="provider-actions">
                          {!provider.isActive && (
                            <button
                              className="btn-small btn-primary"
                              onClick={() => handleSwitchProvider(provider.id)}
                            >
                              <span className="codicon codicon-play" />
                              启用
                            </button>
                          )}
                          <button className="btn-small" onClick={() => handleEditProvider(provider)}>
                            <span className="codicon codicon-edit" />
                            编辑
                          </button>
                          <button
                            className="btn-small btn-danger"
                            onClick={() => handleDeleteProvider(provider)}
                            disabled={providers.length === 1}
                          >
                            <span className="codicon codicon-trash" />
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!loading && (editingProvider || isAdding) && (
                <div className="config-form">
                  <h4>{isAdding ? '添加供应商' : `编辑供应商: ${editingProvider?.name}`}</h4>
                  <p className="section-desc">
                    {isAdding ? '配置新的供应商信息' : '更新配置后将立即应用到当前供应商。'}
                  </p>

                  <div className="form-group">
                    <label htmlFor="providerName">
                      供应商名称
                      <span className="required">*</span>
                    </label>
                    <input
                      id="providerName"
                      type="text"
                      className="form-input"
                      placeholder="例如：Claude官方"
                      value={providerName}
                      onChange={(e) => setProviderName(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="websiteUrl">官网链接</label>
                    <div className="input-with-link">
                      <input
                        id="websiteUrl"
                        type="text"
                        className="form-input"
                        placeholder="https://"
                        value={websiteUrl}
                        onChange={(e) => setWebsiteUrl(e.target.value)}
                      />
                      {websiteUrl && isValidUrl(websiteUrl) && (
                        <a
                          href={websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link-btn"
                          title="访问官网"
                        >
                          <span className="codicon codicon-link-external" />
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="apiKey">
                      API Key
                      <span className="required">*</span>
                    </label>
                    <div className="input-with-visibility">
                      <input
                        id="apiKey"
                        type={showApiKey ? 'text' : 'password'}
                        className="form-input"
                        placeholder="sk-ant-..."
                        value={apiKey}
                        onChange={handleApiKeyChange}
                      />
                      <button
                        type="button"
                        className="visibility-toggle"
                        onClick={() => setShowApiKey(!showApiKey)}
                        title={showApiKey ? '隐藏' : '显示'}
                      >
                        <span className={`codicon ${showApiKey ? 'codicon-eye-closed' : 'codicon-eye'}`} />
                      </button>
                    </div>
                    <small className="form-hint">
                      请输入您的API Key
                    </small>
                  </div>

                  <div className="form-group">
                    <label htmlFor="apiUrl">
                      请求地址 (API Endpoint)
                      <span className="required">*</span>
                    </label>
                    <input
                      id="apiUrl"
                      type="text"
                      className="form-input"
                      placeholder="https://api.anthropic.com"
                      value={apiUrl}
                      onChange={handleApiUrlChange}
                    />
                    <small className="form-hint">
                      <span className="codicon codicon-info" style={{ fontSize: '12px', marginRight: '4px' }} />
                      填写兼容 Claude API 的服务端口地址
                    </small>
                  </div>

                  <details className="advanced-section">
                    <summary className="advanced-toggle">
                      <span className="codicon codicon-chevron-right" />
                      高级选项
                    </summary>
                    <div style={{ padding: '10px 0', color: '#858585', fontSize: '13px' }}>
                      暂无高级选项
                    </div>
                  </details>

                  <details className="advanced-section" open>
                    <summary className="advanced-toggle">
                      <span className="codicon codicon-chevron-right" />
                      配置 JSON
                    </summary>
                    <div className="json-config-section">
                      <div className="json-editor-wrapper">
                        <textarea
                          className="json-editor"
                          value={jsonConfig}
                          onChange={handleJsonChange}
                          placeholder={`{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_BASE_URL": ""
  }
}`}
                        />
                        {jsonError && (
                          <p className="json-error">
                            <span className="codicon codicon-error" />
                            {jsonError}
                          </p>
                        )}
                      </div>
                    </div>
                  </details>

                  <div className="form-actions" style={{ justifyContent: 'flex-end', marginTop: '24px', borderTop: '1px solid #3e3e42', paddingTop: '16px' }}>
                    {!isAdding && (
                        <button 
                        className="btn-small btn-danger"
                        style={{ marginRight: 'auto' }}
                        onClick={() => editingProvider && handleDeleteProvider(editingProvider)}
                        disabled={providers.length === 1}
                        >
                        <span className="codicon codicon-trash" />
                        删除供应商
                        </button>
                    )}

                    <button className="btn-secondary" onClick={handleCancelEdit}>
                      <span className="codicon codicon-close" />
                      取消
                    </button>
                    <button className="btn-primary" onClick={handleSaveProvider}>
                      <span className="codicon codicon-save" />
                      {isAdding ? '确认添加' : '保存更改'}
                    </button>
                  </div>
                </div>
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
              <div className="temp-notice">
                <span className="codicon codicon-server" />
                <p>MCP服务器配置功能即将推出...</p>
              </div>
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
    </div>
  );
};

export default SettingsView;
