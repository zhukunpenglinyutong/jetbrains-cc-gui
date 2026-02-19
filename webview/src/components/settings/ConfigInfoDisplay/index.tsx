import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

/**
 * Current Claude CLI configuration info
 */
export interface ClaudeConfig {
  apiKey: string;
  baseUrl: string;
  providerId?: string;
  providerName?: string;
}

/**
 * Provider configuration
 */
export interface ProviderOption {
  id: string;
  name: string;
  isActive?: boolean;
  source?: string;
}

interface ConfigInfoDisplayProps {
  config: ClaudeConfig | null;
  loading?: boolean;
  providers?: ProviderOption[];
  onSwitchProvider?: (id: string) => void;
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

/**
 * Configuration info display component
 * Displays the current ~/.claude/settings.json configuration
 */
const ConfigInfoDisplay = ({ config, loading = false, providers = [], onSwitchProvider, addToast }: ConfigInfoDisplayProps) => {
  const { t } = useTranslation();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  // Get the currently active provider
  const activeProvider = providers.find(p => p.isActive);
  // Get switchable providers (excluding the currently active one)
  const switchableProviders = providers.filter(p => !p.isActive);
  // Whether there are switchable providers
  const hasSwitchableProviders = switchableProviders.length > 0;

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <span className={styles.title}>
            {t('settings.provider.currentConfig')}
          </span>
        </div>
        <div className={styles.loading}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('settings.provider.loading')}</span>
        </div>
      </div>
    );
  }

  if (!config || (!config.apiKey && !config.baseUrl)) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <span className={styles.title}>
            {t('settings.provider.currentConfig')}
          </span>
        </div>
        <div className={styles.empty}>
          <span className="codicon codicon-warning" />
          <span>{t('settings.provider.noConfig')}</span>
        </div>
      </div>
    );
  }

  const apiKey = config.apiKey || '';
  const baseUrl = config.baseUrl || '';

  // API Key preview (show first/last few characters with dots in between)
  const getApiKeyPreview = () => {
    if (!apiKey) {
      return t('settings.provider.notConfigured');
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
        addToast(t('toast.copySuccess', { label }), 'success');
      }
    }).catch(err => {
      console.error('Failed to copy: ', err);
      if (addToast) {
        addToast(t('toast.copyFailed'), 'error');
      }
    });
  };

  return (
    <div className={styles.container}>
      {/* First row: current provider + badge + switch button */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>
            {t('settings.provider.currentConfig')}
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
              title={t('config.switchProvider')}
            >
              <span className="codicon codicon-arrow-swap" />
              <span>{t('config.switch')}</span>
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
                    {provider.source === 'cc-switch' && (
                      <span className={styles.ccSwitchTag}>cc-switch</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Second row: API Key and Base URL side by side */}
      <div className={styles.content}>
        {/* API Key preview */}
        <div className={styles.field}>
          <span className={`codicon codicon-key ${styles.icon}`} />
          <code
            className={`${styles.value} ${styles.clickable}`}
            onClick={() => handleCopy(apiKey, t('settings.provider.apiKey'))}
            title={t('config.clickToCopy')}
          >
            {getApiKeyPreview()}
          </code>
          {apiKey && (
            <button
              type="button"
              className={styles.toggleBtn}
              onClick={() => setShowApiKey(!showApiKey)}
              title={showApiKey ? t('settings.provider.hide') : t('settings.provider.show')}
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
            onClick={() => handleCopy(baseUrl, t('config.link'))}
            title={t('config.clickToCopy')}
          >
            {baseUrl || t('settings.provider.notConfigured')}
          </code>
        </div>
      </div>
    </div>
  );
};

export default ConfigInfoDisplay;
