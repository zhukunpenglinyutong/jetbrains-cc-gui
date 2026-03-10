import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyToClipboard } from '../../../utils/copyUtils';
import styles from './style.module.less';

/**
 * Current Claude CLI configuration info
 */
export interface ClaudeConfig {
  apiKey: string;
  baseUrl: string;
  providerId?: string;
  providerName?: string;
  authType?: string;
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
  onSwitch?: (id: string) => void;
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

interface TutorialCodeBlock {
  id: string;
  label: string;
  code: string;
}

interface TutorialLinkItem {
  id: string;
  label: string;
  url: string;
}

/**
 * Configuration info display component
 * Displays the current ~/.claude/settings.json configuration
 */
const ConfigInfoDisplay = ({
  config,
  loading = false,
  providers = [],
  onSwitch,
  addToast,
}: ConfigInfoDisplayProps) => {
  const { t, i18n } = useTranslation();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showSubscriptionTutorial, setShowSubscriptionTutorial] = useState(false);
  const [tutorialTab, setTutorialTab] = useState<'claude' | 'codex'>('claude');
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [showSwitchDropdown, setShowSwitchDropdown] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const switchWrapperRef = useRef<HTMLDivElement | null>(null);

  // Get the currently active provider
  const activeProvider = providers.find(p => p.isActive);

  const tutorialProviderKey = tutorialTab === 'codex' ? 'codex' : 'claude';
  const tutorialBasePath = `settings.provider.subscriptionTutorial.providers.${tutorialProviderKey}`;
  const orderedItems = [
    t(`${tutorialBasePath}.item1`),
    t(`${tutorialBasePath}.item2`),
    ...(i18n.exists(`${tutorialBasePath}.item3`) ? [t(`${tutorialBasePath}.item3`)] : []),
  ];
  const primaryCodeBlock: TutorialCodeBlock = {
    id: `${tutorialProviderKey}-empty-env`,
    label: t(`${tutorialBasePath}.emptyConfigCodeLabel`),
    code: t(`${tutorialBasePath}.emptyConfigCode`),
  };
  const fallbackCodeBlock: TutorialCodeBlock = {
    id: `${tutorialProviderKey}-proxy-env`,
    label: t(`${tutorialBasePath}.proxyConfigCodeLabel`),
    code: t(`${tutorialBasePath}.proxyConfigCode`),
  };
  const issueLink: TutorialLinkItem = {
    id: `${tutorialProviderKey}-issue-link`,
    label: t(`${tutorialBasePath}.issueUrl`),
    url: t(`${tutorialBasePath}.issueUrl`),
  };

  useEffect(() => {
    if (!showSubscriptionTutorial) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowSubscriptionTutorial(false);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [showSubscriptionTutorial]);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!showSwitchDropdown) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (switchWrapperRef.current && !switchWrapperRef.current.contains(event.target as Node)) {
        setShowSwitchDropdown(false);
      }
    };

    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [showSwitchDropdown]);

  const openSubscriptionTutorial = () => {
    setTutorialTab('claude');
    setShowSubscriptionTutorial(true);
  };

  const closeSubscriptionTutorial = () => {
    setShowSubscriptionTutorial(false);
    setCopiedCodeId(null);
  };

  const handleTutorialOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      closeSubscriptionTutorial();
    }
  };

  const handleTutorialTabChange = (tab: 'claude' | 'codex') => {
    setTutorialTab(tab);
    setCopiedCodeId(null);
  };

  const handleCopyCode = async (block: TutorialCodeBlock) => {
    const success = await copyToClipboard(block.code);

    if (!success) {
      addToast?.(t('toast.copyFailed'), 'error');
      return;
    }

    setCopiedCodeId(block.id);
    addToast?.(t('toast.copySuccess', { label: block.label }), 'success');

    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }

    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedCodeId(null);
      copyResetTimerRef.current = null;
    }, 1600);
  };

  const tutorialBanner = (
    <button
      type="button"
      className={styles.tutorialBanner}
      onClick={openSubscriptionTutorial}
    >
      <span className={`codicon codicon-book ${styles.tutorialBannerIcon}`} />
      <span>{t('settings.provider.subscriptionTutorial.entry')}</span>
      <span className={`codicon codicon-chevron-right ${styles.tutorialBannerArrow}`} />
    </button>
  );

  const tutorialDialog = showSubscriptionTutorial && (
    <div className="dialog-overlay" onClick={handleTutorialOverlayClick}>
      <div className={`dialog ${styles.tutorialDialog}`}>
        <div className="dialog-header">
          <h3>{t('settings.provider.subscriptionTutorial.dialogTitle')}</h3>
          <button
            type="button"
            className="close-btn"
            onClick={closeSubscriptionTutorial}
            title={t('common.close')}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="dialog-body">
          <div className={styles.tutorialTabs} role="tablist" aria-label={t('settings.provider.subscriptionTutorial.tabAriaLabel')}>
            <button
              type="button"
              role="tab"
              aria-selected={tutorialTab === 'claude'}
              className={`${styles.tutorialTabBtn} ${tutorialTab === 'claude' ? styles.activeTab : ''}`}
              onClick={() => handleTutorialTabChange('claude')}
            >
              {t('settings.provider.subscriptionTutorial.tabs.claude')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tutorialTab === 'codex'}
              className={`${styles.tutorialTabBtn} ${tutorialTab === 'codex' ? styles.activeTab : ''}`}
              onClick={() => handleTutorialTabChange('codex')}
            >
              {t('settings.provider.subscriptionTutorial.tabs.codex')}
            </button>
          </div>

          <div className={styles.tutorialSection}>
            <h4>
              <span className="codicon codicon-info" />
              {t(`${tutorialBasePath}.title`)}
            </h4>
            <ol className={styles.tutorialOrderedList}>
              {orderedItems.map((item, index) => (
                <li key={`${tutorialProviderKey}-item-${index}`}>{item}</li>
              ))}
            </ol>

            {primaryCodeBlock.code && (
              <div className={styles.codeBlockList}>
                <div className={styles.codeBlock}>
                  <div className={styles.codeBlockHeader}>
                    <span className={styles.codeBlockLabel}>{primaryCodeBlock.label}</span>
                    <button
                      type="button"
                      className={styles.copyCodeBtn}
                      onClick={() => handleCopyCode(primaryCodeBlock)}
                      title={t('settings.provider.subscriptionTutorial.code.copy')}
                    >
                      <span className={`codicon ${copiedCodeId === primaryCodeBlock.id ? 'codicon-check' : 'codicon-copy'}`} />
                      <span>
                        {copiedCodeId === primaryCodeBlock.id
                          ? t('settings.provider.subscriptionTutorial.code.copied')
                          : t('settings.provider.subscriptionTutorial.code.copy')}
                      </span>
                    </button>
                  </div>
                  <pre className={styles.codeBlockContent}>
                    <code>{primaryCodeBlock.code}</code>
                  </pre>
                </div>
              </div>
            )}

            {t(`${tutorialBasePath}.noteTitle`) !== '' && (
              <p className={styles.noteTitle}>{t(`${tutorialBasePath}.noteTitle`)}</p>
            )}
            {t(`${tutorialBasePath}.note1`) !== '' && (
              <p>{t(`${tutorialBasePath}.note1`)}</p>
            )}

            {fallbackCodeBlock.code && (
              <div className={styles.codeBlockList}>
                <div className={styles.codeBlock}>
                  <div className={styles.codeBlockHeader}>
                    <span className={styles.codeBlockLabel}>{fallbackCodeBlock.label}</span>
                    <button
                      type="button"
                      className={styles.copyCodeBtn}
                      onClick={() => handleCopyCode(fallbackCodeBlock)}
                      title={t('settings.provider.subscriptionTutorial.code.copy')}
                    >
                      <span className={`codicon ${copiedCodeId === fallbackCodeBlock.id ? 'codicon-check' : 'codicon-copy'}`} />
                      <span>
                        {copiedCodeId === fallbackCodeBlock.id
                          ? t('settings.provider.subscriptionTutorial.code.copied')
                          : t('settings.provider.subscriptionTutorial.code.copy')}
                      </span>
                    </button>
                  </div>
                  <pre className={styles.codeBlockContent}>
                    <code>{fallbackCodeBlock.code}</code>
                  </pre>
                </div>
              </div>
            )}

            <p className={styles.issueParagraph}>
              {t(`${tutorialBasePath}.issuePrefix`)}
              <a
                href={issueLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.inlineIssueLink}
              >
                {issueLink.label}
              </a>
            </p>
          </div>
        </div>

        <div className={`dialog-footer ${styles.tutorialFooter}`}>
          <div className={styles.tutorialFooterRight}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={closeSubscriptionTutorial}
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.title}>
              {t('settings.provider.currentConfig')}
            </span>
          </div>
        </div>
        {tutorialBanner}
        <div className={styles.loading}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('settings.provider.loading')}</span>
        </div>
        {tutorialDialog}
      </div>
    );
  }

  if (!config || (!config.apiKey && !config.baseUrl && config.authType !== 'api_key_helper')) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.title}>
              {t('settings.provider.currentConfig')}
            </span>
          </div>
        </div>
        {tutorialBanner}
        <div className={styles.empty}>
          <span className="codicon codicon-warning" />
          <span>{t('settings.provider.noConfig')}</span>
        </div>
        {tutorialDialog}
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

  const handleCopy = (text: string, label: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      if (addToast) {
        addToast(t('toast.copySuccess', { label }), 'success');
      }
    }).catch(() => {
      if (addToast) {
        addToast(t('toast.copyFailed'), 'error');
      }
    });
  };

  return (
    <div className={styles.container}>
      {/* First row: current provider + badge + switch */}
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
        {providers.length > 0 && onSwitch && (
          <div className={styles.switchWrapper} ref={switchWrapperRef}>
            <button
              type="button"
              className={styles.switchBtn}
              onClick={() => setShowSwitchDropdown(prev => !prev)}
            >
              <span className="codicon codicon-arrow-swap" />
              <span>{t('config.switch')}</span>
              <span className={`codicon ${showSwitchDropdown ? 'codicon-chevron-up' : 'codicon-chevron-down'}`} />
            </button>
            {showSwitchDropdown && (
              <div className={styles.dropdown}>
                {providers.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    className={styles.dropdownItem}
                    onClick={() => {
                      onSwitch(p.id);
                      setShowSwitchDropdown(false);
                    }}
                  >
                    <span>{p.name}</span>
                    {p.source === 'cc-switch' && (
                      <span className={styles.ccSwitchTag}>cc</span>
                    )}
                    {p.isActive && (
                      <span className="codicon codicon-check" style={{ marginLeft: 'auto' }} />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {tutorialBanner}

      {/* Second row: API Key and Base URL side by side */}
      <div className={styles.content}>
        {/* API Key preview */}
        <div className={styles.field}>
          <span className={`codicon codicon-key ${styles.icon}`} />
          {config.authType === 'api_key_helper' ? (
            <code className={styles.value}>
              {t('settings.provider.apiKeyHelper', 'API Key Helper')}
            </code>
          ) : (
            <>
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
            </>
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

      {tutorialDialog}
    </div>
  );
};

export default ConfigInfoDisplay;
