import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig, CodexProxyConfig } from '../../../types/provider';
import styles from './style.module.less';

interface CodexProviderSectionProps {
  codexProviders: CodexProviderConfig[];
  codexLoading: boolean;
  codexProxyConfig: CodexProxyConfig;
  codexProxyLoading: boolean;
  codexProxySaving: boolean;
  codexProxySource: 'global' | 'legacy-provider';
  onAddCodexProvider: () => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
  onSwitchCodexProvider: (id: string) => void;
  onSaveCodexProxyConfig: (config: CodexProxyConfig) => void;
  showHeader?: boolean;
}

const CodexProviderSection = ({
  codexProviders,
  codexLoading,
  codexProxyConfig,
  codexProxyLoading,
  codexProxySaving,
  codexProxySource,
  onAddCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
  onSwitchCodexProvider,
  onSaveCodexProxyConfig,
  showHeader = true,
}: CodexProviderSectionProps) => {
  const { t } = useTranslation();
  const [draftProxy, setDraftProxy] = useState<CodexProxyConfig>({
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '',
  });

  useEffect(() => {
    setDraftProxy({
      HTTP_PROXY: codexProxyConfig.HTTP_PROXY || '',
      HTTPS_PROXY: codexProxyConfig.HTTPS_PROXY || '',
      ALL_PROXY: codexProxyConfig.ALL_PROXY || '',
      NO_PROXY: codexProxyConfig.NO_PROXY || '',
    });
  }, [codexProxyConfig]);

  const isProxyDirty =
    (draftProxy.HTTP_PROXY || '') !== (codexProxyConfig.HTTP_PROXY || '') ||
    (draftProxy.HTTPS_PROXY || '') !== (codexProxyConfig.HTTPS_PROXY || '') ||
    (draftProxy.ALL_PROXY || '') !== (codexProxyConfig.ALL_PROXY || '') ||
    (draftProxy.NO_PROXY || '') !== (codexProxyConfig.NO_PROXY || '');

  return (
    <div className={styles.configSection}>
      {showHeader && (
        <>
          <h3 className={styles.sectionTitle}>{t('settings.codexProvider.title')}</h3>
          <p className={styles.sectionDesc}>{t('settings.codexProvider.description')}</p>
        </>
      )}

      {codexLoading && (
        <div className={styles.tempNotice}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <p>{t('settings.provider.loading')}</p>
        </div>
      )}

      <div className={styles.proxyCard}>
        <div className={styles.proxyHeader}>
          <div>
            <h4>{t('settings.codexProvider.proxy.title')}</h4>
            <p>{t('settings.codexProvider.proxy.description')}</p>
          </div>
          {codexProxySource === 'legacy-provider' && (
            <span className={styles.legacyBadge}>
              {t('settings.codexProvider.proxy.legacySource')}
            </span>
          )}
        </div>

        {codexProxyLoading ? (
          <div className={styles.proxyLoading}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.provider.loading')}</span>
          </div>
        ) : (
          <>
            {codexProxySource === 'legacy-provider' && (
              <p className={styles.proxyLegacyHint}>
                {t('settings.codexProvider.proxy.legacyHint')}
              </p>
            )}
            <div className={styles.proxyGrid}>
              <div className={styles.proxyField}>
                <label htmlFor="codex-http-proxy">HTTP_PROXY</label>
                <input
                  id="codex-http-proxy"
                  className="form-input"
                  value={draftProxy.HTTP_PROXY || ''}
                  placeholder={t('settings.codexProvider.dialog.httpProxy')}
                  onChange={(e) => setDraftProxy((prev) => ({ ...prev, HTTP_PROXY: e.target.value }))}
                />
              </div>
              <div className={styles.proxyField}>
                <label htmlFor="codex-https-proxy">HTTPS_PROXY</label>
                <input
                  id="codex-https-proxy"
                  className="form-input"
                  value={draftProxy.HTTPS_PROXY || ''}
                  placeholder={t('settings.codexProvider.dialog.httpsProxy')}
                  onChange={(e) => setDraftProxy((prev) => ({ ...prev, HTTPS_PROXY: e.target.value }))}
                />
              </div>
              <div className={styles.proxyField}>
                <label htmlFor="codex-all-proxy">ALL_PROXY</label>
                <input
                  id="codex-all-proxy"
                  className="form-input"
                  value={draftProxy.ALL_PROXY || ''}
                  placeholder={t('settings.codexProvider.dialog.allProxy')}
                  onChange={(e) => setDraftProxy((prev) => ({ ...prev, ALL_PROXY: e.target.value }))}
                />
              </div>
              <div className={styles.proxyField}>
                <label htmlFor="codex-no-proxy">NO_PROXY</label>
                <input
                  id="codex-no-proxy"
                  className="form-input"
                  value={draftProxy.NO_PROXY || ''}
                  placeholder={t('settings.codexProvider.dialog.noProxy')}
                  onChange={(e) => setDraftProxy((prev) => ({ ...prev, NO_PROXY: e.target.value }))}
                />
              </div>
            </div>

            <p className={styles.proxyHint}>{t('settings.codexProvider.dialog.proxyHint')}</p>

            <div className={styles.proxyActions}>
              <button
                className="btn btn-secondary"
                onClick={() => setDraftProxy({ HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '' })}
                disabled={codexProxySaving}
              >
                <span className="codicon codicon-clear-all" />
                {t('settings.codexProvider.proxy.clear')}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => onSaveCodexProxyConfig(draftProxy)}
                disabled={codexProxySaving || !isProxyDirty}
              >
                <span className={`codicon ${codexProxySaving ? 'codicon-loading codicon-modifier-spin' : 'codicon-save'}`} />
                {t('settings.codexProvider.proxy.save')}
              </button>
            </div>
          </>
        )}
      </div>

      {!codexLoading && (
        <div className={styles.providerListContainer}>
          <div className={styles.providerListHeader}>
            <h4>{t('settings.provider.allProviders')}</h4>
            <button className="btn btn-primary" onClick={onAddCodexProvider}>
              <span className="codicon codicon-add" />
              {t('common.add')}
            </button>
          </div>

          <div className={styles.providerList}>
            {codexProviders.length > 0 ? (
              codexProviders.map((provider) => (
                <div
                  key={provider.id}
                  className={`${styles.providerCard} ${provider.isActive ? styles.active : ''}`}
                >
                  <div className={styles.providerInfo}>
                    <div className={styles.providerName}>{provider.name}</div>
                    {provider.remark && (
                      <div className={styles.providerRemark}>{provider.remark}</div>
                    )}
                  </div>

                  <div className={styles.providerActions}>
                    {provider.isActive ? (
                      <div className={styles.activeBadge}>
                        <span className="codicon codicon-check" />
                        {t('settings.provider.inUse')}
                      </div>
                    ) : (
                      <button
                        className={styles.useButton}
                        onClick={() => onSwitchCodexProvider(provider.id)}
                      >
                        <span className="codicon codicon-play" />
                        {t('settings.provider.enable')}
                      </button>
                    )}

                    <div className={styles.actionButtons}>
                      <button
                        className={styles.iconBtn}
                        onClick={() => onEditCodexProvider(provider)}
                        title={t('common.edit')}
                      >
                        <span className="codicon codicon-edit" />
                      </button>
                      <button
                        className={styles.iconBtn}
                        onClick={() => onDeleteCodexProvider(provider)}
                        title={t('common.delete')}
                      >
                        <span className="codicon codicon-trash" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className={styles.emptyState}>
                <span className="codicon codicon-info" />
                <p>{t('settings.codexProvider.emptyProvider')}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CodexProviderSection;
