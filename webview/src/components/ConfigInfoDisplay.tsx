import { useState } from 'react';
import type { ProviderConfig } from '../types/provider';

interface ConfigInfoDisplayProps {
  provider: ProviderConfig | null;
  loading?: boolean;
}

/**
 * 配置信息展示组件
 * 用于展示当前的 API 配置信息
 */
const ConfigInfoDisplay = ({ provider, loading = false }: ConfigInfoDisplayProps) => {
  const [showApiKey, setShowApiKey] = useState(false);

  if (loading) {
    return (
      <div className="config-info-display">
        <div className="config-info-header">
          <span className="codicon codicon-info" style={{ fontSize: '16px', color: 'var(--accent-primary)' }} />
          <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
            当前应用的配置          </span>
        </div>
        <div className="config-info-loading">
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>加载中...</span>
        </div>
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="config-info-display">
        <div className="config-info-header">
          <span className="codicon codicon-info" style={{ fontSize: '16px', color: 'var(--accent-primary)' }} />
          <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
            当前应用的配置          </span>
        </div>
        <div className="config-info-empty">
          <span className="codicon codicon-warning" />
          <span>暂无配置信息</span>
        </div>
      </div>
    );
  }

  const apiKey = provider.settingsConfig?.env?.ANTHROPIC_AUTH_TOKEN || '';
  const baseUrl = provider.settingsConfig?.env?.ANTHROPIC_BASE_URL || '';

  // API Key 来源判断
  const getApiKeySource = () => {
    if (!apiKey) {
      return '未配置';
    }
    if (apiKey.startsWith('sk-ant-')) {
      return 'Claude 官方';
    }
    return '第三方供应商';
  };

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

  return (
    <div className="config-info-display">
      <div className="config-info-header">
        <span className="codicon codicon-info" style={{ fontSize: '16px', color: 'var(--accent-primary)' }} />
        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          当前应用的配置        </span>
      </div>

      <div className="config-info-body">
        {/* API Key 来源 */}
        <div className="config-info-item">
          <div className="config-info-label">
            <span className="codicon codicon-key" />
            <span>API Key 来源</span>
          </div>
          <div className="config-info-value">
            {getApiKeySource()}
          </div>
        </div>

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

        {/* 供应商名称 */}
        <div className="config-info-item">
          <div className="config-info-label">
            <span className="codicon codicon-server" />
            <span>供应商</span>
          </div>
          <div className="config-info-value">
            {provider.name}
            {provider.isActive && (
              <span className="config-info-badge">使用中</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigInfoDisplay;
