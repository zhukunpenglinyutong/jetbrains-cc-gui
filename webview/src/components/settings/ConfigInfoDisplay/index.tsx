import { useState } from 'react';
import styles from './style.module.less';

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
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

/**
 * 配置信息展示组件
 * 用于展示当前 ~/.claude/settings.json 的配置信息
 */
const ConfigInfoDisplay = ({ config, loading = false, providers = [], onSwitchProvider, addToast }: ConfigInfoDisplayProps) => {
  const [showApiKey, setShowApiKey] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  // 获取当前激活的供应商
  const activeProvider = providers.find(p => p.isActive);
  // 获取可切换的供应商（过滤掉当前选中的）
  const switchableProviders = providers.filter(p => !p.isActive);
  // 是否有可切换的供应商
  const hasSwitchableProviders = switchableProviders.length > 0;

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <span className={styles.title}>
            当前ClaudeCode配置
          </span>
        </div>
        <div className={styles.loading}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>加载中...</span>
        </div>
      </div>
    );
  }

  if (!config || (!config.apiKey && !config.baseUrl)) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <span className={styles.title}>
            当前ClaudeCode配置
          </span>
        </div>
        <div className={styles.empty}>
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

  const handleCopy = (text: string, label: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      if (addToast) {
        addToast(`${label}已复制到剪切板`, 'success');
      }
    }).catch(err => {
      console.error('Failed to copy: ', err);
      if (addToast) {
        addToast('复制失败', 'error');
      }
    });
  };

  return (
    <div className={styles.container}>
      {/* 第一行：当前供应商 + 徽章 + 切换按钮 */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>
            当前ClaudeCode配置
          </span>
          {activeProvider && (
            <span className={styles.badge}>
              {activeProvider.name}
            </span>
          )}
        </div>
        {hasSwitchableProviders && onSwitchProvider && (
          <div className={styles.switchWrapper}>
            <button
              type="button"
              className={styles.switchBtn}
              onClick={() => setShowDropdown(!showDropdown)}
              title="切换供应商"
            >
              <span className="codicon codicon-arrow-swap" />
              <span>切换</span>
              <span className={`codicon codicon-chevron-${showDropdown ? 'up' : 'down'}`} />
            </button>
            {showDropdown && (
              <div className={styles.dropdown}>
                {switchableProviders.map(provider => (
                  <button
                    key={provider.id}
                    type="button"
                    className={styles.dropdownItem}
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

      {/* 第二行：API Key 和 Base URL 并排 */}
      <div className={styles.content}>
        {/* API Key 预览 */}
        <div className={styles.field}>
          <span className={`codicon codicon-key ${styles.icon}`} />
          <code 
            className={`${styles.value} ${styles.clickable}`}
            onClick={() => handleCopy(apiKey, 'API Key')}
            title="点击复制"
          >
            {getApiKeyPreview()}
          </code>
          {apiKey && (
            <button
              type="button"
              className={styles.toggleBtn}
              onClick={() => setShowApiKey(!showApiKey)}
              title={showApiKey ? '隐藏' : '显示'}
            >
              <span className={`codicon ${showApiKey ? 'codicon-eye-closed' : 'codicon-eye'}`} style={{ fontSize: '14px' }} />
            </button>
          )}
        </div>

        {/* Base URL */}
        <div className={styles.field}>
          <span className={`codicon codicon-globe ${styles.icon}`} />
          <code 
            className={`${styles.value} ${styles.clickable}`}
            onClick={() => handleCopy(baseUrl, '链接')}
            title="点击复制"
          >
            {baseUrl || '未配置'}
          </code>
        </div>
      </div>
    </div>
  );
};

export default ConfigInfoDisplay;
