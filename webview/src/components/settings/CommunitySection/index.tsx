import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChangelogDialog from '../../ChangelogDialog';
import { CHANGELOG_DATA } from '../../../version/changelog';
import styles from './style.module.less';

const CommunitySection = () => {
  const { t } = useTranslation();
  const [showChangelog, setShowChangelog] = useState(false);

  return (
    <div className={styles.configSection}>
      {/* Official community group */}
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

      {/* Version history */}
      <div className={styles.versionHistorySection}>
        <h3 className={styles.sectionTitle}>{t('settings.versionHistory')}</h3>
        <p className={styles.sectionDesc}>{t('settings.versionHistoryDesc')}</p>
        <button
          className={styles.versionHistoryBtn}
          onClick={() => setShowChangelog(true)}
        >
          <span className="codicon codicon-history" />
          {t('settings.versionHistory')}
        </button>
      </div>

      <ChangelogDialog
        isOpen={showChangelog}
        onClose={() => setShowChangelog(false)}
        entries={CHANGELOG_DATA}
      />
    </div>
  );
};

export default CommunitySection;
