import { useState } from 'react';

/**
 * Claude CLI 当前配置信息
 */
export interface ClaudeConfig {
  apiKey: string;
  baseUrl: string;
  providerId?: string;
  providerName?: string;
}

/**
 * 供应商配置
 */
export interface ProviderOption {
  id: string;
  name: string;
  isActive?: boolean;
}

interface ConfigInfoDisplayProps {
  config: ClaudeConfig | null;
  loading?: boolean;
  providers?: ProviderOption[];
  onSwitchProvider?: (id: string) => void;
}

/**
 * 配置信息展示组件
 * 用于展示当前 ~/.claude/settings.json 的配置信息
 */
const ConfigInfoDisplay = ({ config, loading = false, providers = [], onSwitchProvider }: ConfigInfoDisplayProps) => {
  const [showApiKey, setShowApiKey] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  // 获取当前激活的供应商
  const activeProvider = providers.find(p => p.isActive);
  // 获取可切换的供应商（非激活状态的）
  const switchableProviders = providers.filter(p => !p.isActive);
  // 是否有可切换的供应商
  const hasSwitchableProviders = switchableProviders.length > 0;

  if (loading) {
    return (
      <div className="config-info-display">
        <div className="config-info-header">
          <span className="codicon codicon-info" />
          <span className="config-info-title">
            当前 Claude CLI 配置
          </span>
        </div>
        <div className="config-info-loading">
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>加载中...</span>
        </div>
      </div>
    );
  }

  if (!config || (!config.apiKey && !config.baseUrl)) {
    return (
      <div className="config-info-display">
        <div className="config-info-header">
          <span className="codicon codicon-info" />
          <span className="config-info-title">
            当前 Claude CLI 配置
          </span>
        </div>
        <div className="config-info-empty">
          <span className="codicon codicon-warning" />
          <span>暂无配置信息</span>
        </div>
      </div>
    );
  }

  const apiKey = config.apiKey || '';
  const baseUrl = config.baseUrl || '';

  // API Key 预览（显示前后各几位，中间用省略号）
  const getApiKeyPreview = () => {
    if (!apiKey) {
      return '未配置';
    }
    if (showApiKey) {
      return apiKey;
    }
    if (apiKey.length <= 10) {
      return '•'.repeat(apiKey.length);
    }
    return `${apiKey.slice(0, 8)}${'•'.repeat(8)}${apiKey.slice(-4)}`;
  };

  const handleSwitchClick = (providerId: string) => {
    if (onSwitchProvider) {
      onSwitchProvider(providerId);
    }
    setShowDropdown(false);
  };

  return (
    <div className="config-info-display">
      <div className="config-info-header">
        <div className="config-info-header-left">
          <span className="codicon codicon-info" />
          <span className="config-info-title">
            当前 Claude CLI 配置
          </span>
          {activeProvider && (
            <span className="config-info-provider-badge">
              {activeProvider.name}
            </span>
          )}
        </div>
        {hasSwitchableProviders && onSwitchProvider && (
          <div className="config-info-switch-wrapper">
            <button
              type="button"
              className="config-info-switch-btn"
              onClick={() => setShowDropdown(!showDropdown)}
              title="切换供应商"
            >
              <span className="codicon codicon-arrow-swap" />
              <span>切换</span>
              <span className={`codicon codicon-chevron-${showDropdown ? 'up' : 'down'}`} />
            </button>
            {showDropdown && (
              <div className="config-info-dropdown">
                {switchableProviders.map(provider => (
                  <button
                    key={provider.id}
                    type="button"
                    className="config-info-dropdown-item"
                    onClick={() => handleSwitchClick(provider.id)}
                  >
                    <span className="codicon codicon-server" />
                    <span>{provider.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="config-info-body">
        {/* API Key 预览 */}
        <div className="config-info-item">
          <div className="config-info-label">
            <span className="codicon codicon-lock" />
            <span>API Key 预览</span>
          </div>
          <div className="config-info-value-with-action">
            <code className="config-info-code">
              {getApiKeyPreview()}
            </code>
            {apiKey && (
              <button
                type="button"
                className="config-info-toggle"
                onClick={() => setShowApiKey(!showApiKey)}
                title={showApiKey ? '隐藏' : '显示'}
              >
                <span className={`codicon ${showApiKey ? 'codicon-eye-closed' : 'codicon-eye'}`} />
              </button>
            )}
          </div>
        </div>

        {/* Base URL */}
        <div className="config-info-item">
          <div className="config-info-label">
            <span className="codicon codicon-globe" />
            <span>Base URL 地址</span>
          </div>
          <div className="config-info-value">
            <code className="config-info-code">
              {baseUrl || '未配置'}
            </code>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigInfoDisplay;
