import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

interface SettingsHeaderProps {
  onClose: () => void;
  version?: string;
}

const SettingsHeader = ({ onClose, version }: SettingsHeaderProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.header}>
      <div className={styles.headerLeft}>
        <button className={styles.backBtn} onClick={onClose} title={t('common.back', '返回')}>
          <svg
            className={styles.svgIcon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className={styles.title}>{t('settings.title')}</h2>
        {version && (
          <span className={styles.headerBadge}>v{version}</span>
        )}
      </div>
    </div>
  );
};

export default SettingsHeader;
