import UsageStatisticsSection from '../../UsageStatisticsSection';
import styles from './style.module.less';

const UsageSection = () => {
  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>使用统计</h3>
      <p className={styles.sectionDesc}>查看您的 Token 消耗、费用统计和使用趋势分析</p>
      <UsageStatisticsSection />
    </div>
  );
};

export default UsageSection;
