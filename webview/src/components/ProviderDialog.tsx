import { useState, useEffect } from 'react';
import type { ProviderConfig } from '../types/provider';

interface ProviderDialogProps {
  isOpen: boolean;
  provider?: ProviderConfig | null; // null 表示添加模式
  onClose: () => void;
  onSave: (data: {
    providerName: string;
    websiteUrl: string;
    apiKey: string;
    apiUrl: string;
    jsonConfig: string;
  }) => void;
  onDelete?: (provider: ProviderConfig) => void;
  canDelete?: boolean;
  copyToClipboard: (text: string) => Promise<boolean>;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

export default function ProviderDialog({
  isOpen,
  provider,
  onClose,
  onSave,
  onDelete: _onDelete,
  canDelete: _canDelete = true,
  copyToClipboard,
  addToast,
}: ProviderDialogProps) {
  const isAdding = !provider;
  
  const [providerName, setProviderName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [jsonConfig, setJsonConfig] = useState('');
  const [jsonError, setJsonError] = useState('');

  // 初始化表单
  useEffect(() => {
    if (isOpen) {
      if (provider) {
        // 编辑模式
        setProviderName(provider.name || '');
        setWebsiteUrl(provider.websiteUrl || '');
        setApiKey(provider.settingsConfig?.env?.ANTHROPIC_AUTH_TOKEN || provider.settingsConfig?.env?.ANTHROPIC_API_KEY || '');
        // 编辑模式下不填充默认值，避免覆盖用户实际使用的第三方代理 URL
        setApiUrl(provider.settingsConfig?.env?.ANTHROPIC_BASE_URL || '');

        const config = provider.settingsConfig || {
          env: {
            ANTHROPIC_AUTH_TOKEN: '',
            ANTHROPIC_BASE_URL: '',
          }
        };
        setJsonConfig(JSON.stringify(config, null, 2));
      } else {
        // 添加模式
        setProviderName('');
        setWebsiteUrl('');
        setApiKey('');
        setApiUrl('');
        const config = {
          env: {
            ANTHROPIC_AUTH_TOKEN: '',
            ANTHROPIC_BASE_URL: '',
          }
        };
        setJsonConfig(JSON.stringify(config, null, 2));
      }
      setShowApiKey(false);
      setJsonError('');
    }
  }, [isOpen, provider]);

  // ESC 键关闭
  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newApiKey = e.target.value;
    setApiKey(newApiKey);
    
    try {
      const config = JSON.parse(jsonConfig);
      if (!config.env) config.env = {};
      config.env.ANTHROPIC_AUTH_TOKEN = newApiKey;
      setJsonConfig(JSON.stringify(config, null, 2));
      setJsonError('');
    } catch {
      // JSON 解析失败，忽略
    }
  };

  const handleApiUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newApiUrl = e.target.value;
    setApiUrl(newApiUrl);
    
    try {
      const config = JSON.parse(jsonConfig);
      if (!config.env) config.env = {};
      config.env.ANTHROPIC_BASE_URL = newApiUrl;
      setJsonConfig(JSON.stringify(config, null, 2));
      setJsonError('');
    } catch {
      // JSON 解析失败，忽略
    }
  };

  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newJson = e.target.value;
    setJsonConfig(newJson);
    
    try {
      const config = JSON.parse(newJson);
      if (config.env) {
        if (config.env.ANTHROPIC_AUTH_TOKEN !== undefined) {
          setApiKey(config.env.ANTHROPIC_AUTH_TOKEN);
        } else if (config.env.ANTHROPIC_API_KEY !== undefined) {
          setApiKey(config.env.ANTHROPIC_API_KEY);
        }
        if (config.env.ANTHROPIC_BASE_URL !== undefined) {
          setApiUrl(config.env.ANTHROPIC_BASE_URL);
        }
      }
      setJsonError('');
    } catch (err) {
      setJsonError('JSON 格式无效');
    }
  };

  const handleSave = () => {
    onSave({
      providerName,
      websiteUrl,
      apiKey,
      apiUrl,
      jsonConfig,
    });
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog provider-dialog">
        <div className="dialog-header">
          <h3>{isAdding ? '添加供应商' : `编辑供应商: ${provider?.name}`}</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">
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
                <button
                  type="button"
                  className="link-btn"
                  title="复制链接"
                  onClick={async () => {
                    const success = await copyToClipboard(websiteUrl);
                    if (success) {
                      addToast('链接已复制，请到浏览器打开', 'success');
                    } else {
                      addToast('复制失败，请手动复制', 'error');
                    }
                  }}
                >
                  <span className="codicon codicon-copy" />
                </button>
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
            <small className="form-hint">请输入您的API Key</small>
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

          {/* 高级选项 - 暂时隐藏，后续会使用 */}
          {/* <details className="advanced-section">
            <summary className="advanced-toggle">
              <span className="codicon codicon-chevron-right" />
              高级选项
            </summary>
            <div style={{ padding: '10px 0', color: '#858585', fontSize: '13px' }}>
              暂无高级选项
            </div>
          </details> */}

          <details className="advanced-section" open>
            <summary className="advanced-toggle">
              <span className="codicon codicon-chevron-right" />
              配置 JSON
            </summary>
            <div className="json-config-section">
              <p className="section-desc" style={{ marginBottom: '12px', fontSize: '12px', color: '#999' }}>
                此处可配置完整的 settings.json 内容，支持所有字段（如 model、alwaysThinkingEnabled、ccSwitchProviderId、codemossProviderId 等）
              </p>
              <div className="json-editor-wrapper">
                <textarea
                  className="json-editor"
                  value={jsonConfig}
                  onChange={handleJsonChange}
                  placeholder={`{
  "env": {
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_BASE_URL": ""
  },
  "model": "opus",
  "alwaysThinkingEnabled": false,
  "ccSwitchProviderId": "default",
  "codemossProviderId": ""
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
        </div>

        <div className="dialog-footer">
          <div className="footer-actions" style={{ marginLeft: 'auto' }}>
            <button className="btn btn-secondary" onClick={onClose}>
              <span className="codicon codicon-close" />
              取消
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              <span className="codicon codicon-save" />
              {isAdding ? '确认添加' : '保存更改'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

