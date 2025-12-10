import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

const CommunitySection = () => {
  const { t } = useTranslation();

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.community')}</h3>
      <p className={styles.sectionDesc}>{t('settings.communityDesc')}</p>

      <div className={styles.qrcodeContainer}>
        <div className={styles.qrcodeWrapper}>
          <img
            src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/vscode/wxq.png"
            alt={t('settings.communityQrAlt')}
            className={styles.qrcodeImage}
          />
          <p className={styles.qrcodeTip}>{t('settings.communityQrTip')}</p>
        </div>
      </div>
    </div>
  );
};

export default CommunitySection;
