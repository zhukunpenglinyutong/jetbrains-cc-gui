import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

interface SettingsHeaderProps {
  onClose: () => void;
}

const SettingsHeader = ({ onClose }: SettingsHeaderProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.header}>
      <div className={styles.headerLeft}>
        <button className={styles.backBtn} onClick={onClose}>
          <span className="codicon codicon-arrow-left" />
        </button>
        <h2 className={styles.title}>{t('settings.title')}</h2>
      </div>
    </div>
  );
};

export default SettingsHeader;
