import { useTranslation } from 'react-i18next';
import UsageStatisticsSection from '../../UsageStatisticsSection';
import styles from './style.module.less';

interface UsageSectionProps {
  currentProvider?: string;
}

const UsageSection = ({ currentProvider }: UsageSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.usage')}</h3>
      <p className={styles.sectionDesc}>{t('settings.usageDesc')}</p>
      <UsageStatisticsSection currentProvider={currentProvider} />
    </div>
  );
};

export default UsageSection;
