import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

interface ListStatusProps {
  loading: boolean;
  onRetry: () => void;
}

const ListStatus = ({ loading, onRetry }: ListStatusProps) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className={styles.loadingState}>
        <span className="codicon codicon-loading codicon-modifier-spin" />
        <span>{t('settings.dependency.loading')}</span>
      </div>
    );
  }

  return (
    <div className={styles.loadingState}>
      <span className="codicon codicon-warning" />
      <span>{t('chat.sdkStatusUnavailable')}</span>
      <button type="button" className={styles.retryButton} onClick={onRetry}>
        <span className="codicon codicon-refresh" />
        <span>{t('chat.retrySdkStatus')}</span>
      </button>
    </div>
  );
};

export default ListStatus;
