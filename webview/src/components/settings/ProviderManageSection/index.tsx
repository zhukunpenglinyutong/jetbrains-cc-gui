import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../../../types/provider';
import ProviderList from '../ProviderList';
import styles from './style.module.less';

interface ProviderManageSectionProps {
  providers: ProviderConfig[];
  loading: boolean;
  onAddProvider: () => void;
  onEditProvider: (provider: ProviderConfig) => void;
  onDeleteProvider: (provider: ProviderConfig) => void;
  onSwitchProvider: (id: string) => void;
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  showHeader?: boolean;
}

const ProviderManageSection = ({
  providers,
  loading,
  onAddProvider,
  onEditProvider,
  onDeleteProvider,
  onSwitchProvider,
  addToast,
  showHeader = true,
}: ProviderManageSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.configSection}>
      {showHeader && (
        <>
          <h3 className={styles.sectionTitle}>{t('settings.providers')}</h3>
          <p className={styles.sectionDesc}>{t('settings.providersDesc')}</p>
        </>
      )}
      {loading && (
        <div className={styles.tempNotice}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <p>{t('settings.provider.loading')}</p>
        </div>
      )}

      {!loading && (
        <ProviderList
          providers={providers}
          onAdd={onAddProvider}
          onEdit={onEditProvider}
          onDelete={onDeleteProvider}
          onSwitch={onSwitchProvider}
          addToast={addToast}
          emptyState={
            <>
              <span className="codicon codicon-info" />
              <p>{t('settings.provider.emptyProvider')}</p>
            </>
          }
        />
      )}
    </div>
  );
};

export default ProviderManageSection;
