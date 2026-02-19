import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChangelogDialog from '../../ChangelogDialog';
import { CHANGELOG_DATA } from '../../../version/changelog';
import styles from './style.module.less';

const CommunitySection = () => {
  const { t, i18n } = useTranslation();
  const isSimplifiedChinese = i18n.language === 'zh';
  const [showChangelog, setShowChangelog] = useState(false);

  const sponsorItems = [
    {
      key: 'alipay',
      src: 'https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/zfb.jpg',
      label: t('settings.alipay'),
    },
    {
      key: 'wechat',
      src: 'https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/wx.jpg',
      label: t('settings.wechatPay'),
    },
    {
      key: 'paypal',
      src: 'https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/paypal.png',
      label: t('settings.paypal'),
    },
  ];

  // For non-Simplified Chinese locales, put PayPal first
  const orderedItems = isSimplifiedChinese
    ? sponsorItems
    : [sponsorItems[2], sponsorItems[0], sponsorItems[1]];

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

      {/* Sponsorship support */}
      <div className={styles.sponsorSection}>
        <h3 className={styles.sectionTitle}>{t('settings.sponsor')}</h3>
        <p className={styles.sectionDesc}>{t('settings.sponsorDesc')}</p>

        <div className={styles.sponsorContainer}>
          {orderedItems.map((item) => (
            <div key={item.key} className={styles.sponsorItem}>
              <img
                src={item.src}
                alt={item.label}
                className={styles.sponsorImage}
              />
              <p className={styles.sponsorLabel}>{item.label}</p>
            </div>
          ))}
        </div>
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
