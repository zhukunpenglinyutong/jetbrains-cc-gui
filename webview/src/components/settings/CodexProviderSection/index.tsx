import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../../types/provider';
import styles from './style.module.less';

interface CodexProviderSectionProps {
  codexProviders: CodexProviderConfig[];
  codexLoading: boolean;
  onAddCodexProvider: () => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
  onSwitchCodexProvider: (id: string) => void;
  showHeader?: boolean;
}

const CodexProviderSection = ({
  codexProviders,
  codexLoading,
  onAddCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
  onSwitchCodexProvider,
  showHeader = true,
}: CodexProviderSectionProps) => {
  const { t } = useTranslation();

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
