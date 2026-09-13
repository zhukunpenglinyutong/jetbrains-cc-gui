import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ChangelogDialog from '../../ChangelogDialog';
import { CHANGELOG_DATA } from '../../../version/changelog';
import { openBrowser } from '../../../utils/bridge';
import { copyToClipboard } from '../../../utils/copyUtils';
import wxqImage from '../../../assets/images/wxq.png';
import douyinImage from '../../../assets/images/douyin.png';
import styles from './style.module.less';

const GITHUB_URL = 'https://github.com/zhukunpenglinyutong/idea-claude-code-gui';
const X_URL = 'https://x.com/ZPeng31310';
const ZHIHU_URL = 'https://www.zhihu.com/people/vscodeai';
const XIAOHONGSHU_URL = 'https://www.xiaohongshu.com/user/profile/64bd7444000000001403e31e';
const DOCS_URL = 'https://docs.mossx.ai/jetbrains';
// Channel handle is non-ASCII (@昆鹏马上优化); percent-encode so the JCEF bridge can parse the URI.
const YOUTUBE_URL =
  'https://www.youtube.com/@%E6%98%86%E9%B9%8F%E9%A9%AC%E4%B8%8A%E4%BC%98%E5%8C%96';
const DOUYIN_ID = 'nengyongai';

/* Brand icons (simple-icons / iconify paths, 24x24 viewBox) */
const GITHUB_PATH =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';
const X_PATH =
  'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z';
const XIAOHONGSHU_PATH =
  'M22.405 9.879c.002.016.01.02.07.019h.725a.797.797 0 0 0 .78-.972.794.794 0 0 0-.884-.618.795.795 0 0 0-.692.794c0 .101-.002.666.001.777zm-11.509 4.808c-.203.001-1.353.004-1.685.003a2.528 2.528 0 0 1-.766-.126.025.025 0 0 0-.03.014L7.7 16.127a.025.025 0 0 0 .01.032c.111.06.336.124.495.124.66.01 1.32.002 1.981 0 .01 0 .02-.006.023-.015l.712-1.545a.025.025 0 0 0-.024-.036zM.477 9.91c-.071 0-.076.002-.076.01a.834.834 0 0 0-.01.08c-.027.397-.038.495-.234 3.06-.012.24-.034.389-.135.607-.026.057-.033.042.003.112.046.092.681 1.523.787 1.74.008.015.011.02.017.02.008 0 .033-.026.047-.044.147-.187.268-.391.371-.606.306-.635.44-1.325.486-1.706.014-.11.021-.22.03-.33l.204-2.616.022-.293c.003-.029 0-.033-.03-.034zm7.203 3.757a1.427 1.427 0 0 1-.135-.607c-.004-.084-.031-.39-.235-3.06a.443.443 0 0 0-.01-.082c-.004-.011-.052-.008-.076-.008h-1.48c-.03.001-.034.005-.03.034l.021.293c.076.982.153 1.964.233 2.946.05.4.186 1.085.487 1.706.103.215.223.419.37.606.015.018.037.051.048.049.02-.003.742-1.642.804-1.765.036-.07.03-.055.003-.112zm3.861-.913h-.872a.126.126 0 0 1-.116-.178l1.178-2.625a.025.025 0 0 0-.023-.035l-1.318-.003a.148.148 0 0 1-.135-.21l.876-1.954a.025.025 0 0 0-.023-.035h-1.56c-.01 0-.02.006-.024.015l-.926 2.068c-.085.169-.314.634-.399.938a.534.534 0 0 0-.02.191.46.46 0 0 0 .23.378.981.981 0 0 0 .46.119h.59c.041 0-.688 1.482-.834 1.972a.53.53 0 0 0-.023.172.465.465 0 0 0 .23.398c.15.092.342.12.475.12l1.66-.001c.01 0 .02-.006.023-.015l.575-1.28a.025.025 0 0 0-.024-.035zm-6.93-4.937H3.1a.032.032 0 0 0-.034.033c0 1.048-.01 2.795-.01 6.829 0 .288-.269.262-.28.262h-.74c-.04.001-.044.004-.04.047.001.037.465 1.064.555 1.263.01.02.03.033.051.033.157.003.767.009.938-.014.153-.02.3-.06.438-.132.3-.156.49-.419.595-.765.052-.172.075-.353.075-.533.002-2.33 0-4.66-.007-6.991a.032.032 0 0 0-.032-.032zm11.784 6.896c0-.014-.01-.021-.024-.022h-1.465c-.048-.001-.049-.002-.05-.049v-4.66c0-.072-.005-.07.07-.07h.863c.08 0 .075.004.075-.074V8.393c0-.082.006-.076-.08-.076h-3.5c-.064 0-.075-.006-.075.073v1.445c0 .083-.006.077.08.077h.854c.075 0 .07-.004.07.07v4.624c0 .095.008.084-.085.084-.37 0-1.11-.002-1.304 0-.048.001-.06.03-.06.03l-.697 1.519s-.014.025-.008.036c.006.01.013.008.058.008 1.748.003 3.495.002 5.243.002.03-.001.034-.006.035-.033v-1.539zm4.177-3.43c0 .013-.007.023-.02.024-.346.006-.692.004-1.037.004-.014-.002-.022-.01-.022-.024-.005-.434-.007-.869-.01-1.303 0-.072-.006-.071.07-.07l.733-.003c.041 0 .081.002.12.015.093.025.16.107.165.204.006.431.002 1.153.001 1.153zm2.67.244a1.953 1.953 0 0 0-.883-.222h-.18c-.04-.001-.04-.003-.042-.04V10.21c0-.132-.007-.263-.025-.394a1.823 1.823 0 0 0-.153-.53 1.533 1.533 0 0 0-.677-.71 2.167 2.167 0 0 0-1-.258c-.153-.003-.567 0-.72 0-.07 0-.068.004-.068-.065V7.76c0-.031-.01-.041-.046-.039H17.93s-.016 0-.023.007c-.006.006-.008.012-.008.023v.546c-.008.036-.057.015-.082.022h-.95c-.022.002-.028.008-.03.032v1.481c0 .09-.004.082.082.082h.913c.082 0 .072.128.072.128V11.19s.003.117-.06.117h-1.482c-.068 0-.06.082-.06.082v1.445s-.01.068.064.068h1.457c.082 0 .076-.006.076.079v3.225c0 .088-.007.081.082.081h1.43c.09 0 .082.007.082-.08v-3.27c0-.029.006-.035.033-.035l2.323-.003c.098 0 .191.02.28.061a.46.46 0 0 1 .274.407c.008.395.003.79.003 1.185 0 .259-.107.367-.33.367h-1.218c-.023.002-.029.008-.028.033.184.437.374.871.57 1.303a.045.045 0 0 0 .04.026c.17.005.34.002.51.003.15-.002.517.004.666-.01a2.03 2.03 0 0 0 .408-.075c.59-.18.975-.698.976-1.313v-1.981c0-.128-.01-.254-.034-.38 0 .078-.029-.641-.724-.998z';
const ZHIHU_PATH =
  'M5.721 0C2.251 0 0 2.25 0 5.719V18.28C0 21.751 2.252 24 5.721 24h12.56C21.751 24 24 21.75 24 18.281V5.72C24 2.249 21.75 0 18.281 0zm1.964 4.078c-.271.73-.5 1.434-.68 2.11h4.587c.545-.006.445 1.168.445 1.171H9.384a58.104 58.104 0 01-.112 3.797h2.712c.388.023.393 1.251.393 1.266H9.183a9.223 9.223 0 01-.408 2.102l.757-.604c.452.456 1.512 1.712 1.906 2.177.473.681.063 2.081.063 2.081l-2.794-3.382c-.653 2.518-1.845 3.607-1.845 3.607-.523.468-1.58.82-2.64.516 2.218-1.73 3.44-3.917 3.667-6.497H4.491c0-.015.197-1.243.806-1.266h2.71c.024-.32.086-3.254.086-3.797H6.598c-.136.406-.158.447-.268.753-.594 1.095-1.603 1.122-1.907 1.155.906-1.821 1.416-3.6 1.591-4.064.425-1.124 1.671-1.125 1.671-1.125zM13.078 6h6.377v11.33h-2.573l-2.184 1.373-.401-1.373h-1.219zm1.313 1.219v8.86h.623l.263.937 1.455-.938h1.456v-8.86z';
const DOUYIN_PATH =
  'M16.6 5.82s.51.5 0 0A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5c-1.42 0-2.6-1.16-2.6-2.6c0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64c0 3.33 2.76 5.7 5.69 5.7c3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3s-1.88.09-3.24-1.48';
const YOUTUBE_PATH =
  'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z';

const BrandIcon = ({ path }: { path: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d={path} />
  </svg>
);

interface CommunitySectionProps {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

const CommunitySection = ({ addToast }: CommunitySectionProps) => {
  const { t } = useTranslation();
  const [showChangelog, setShowChangelog] = useState(false);

  const handleCopyDouyinId = useCallback(async () => {
    const copied = await copyToClipboard(DOUYIN_ID);
    addToast(
      t(copied ? 'settings.douyinCopied' : 'settings.douyinCopyFailed'),
      copied ? 'success' : 'error',
    );
  }, [addToast, t]);

  // JCEF won't route target=_blank to the system browser — go through the bridge.
  const openExternal = useCallback((event: MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    openBrowser(url);
  }, []);

  return (
    <div className={styles.configSection}>
      {/* Official community group */}
      <h3 className={styles.sectionTitle}>{t('settings.community')}</h3>
      <p className={styles.sectionDesc}>{t('settings.communityDesc')}</p>

      <div className={styles.qrcodeContainer}>
        <div className={styles.qrcodeWrapper}>
          <img
            src={wxqImage}
            alt={t('settings.communityQrAlt')}
            className={styles.qrcodeImage}
          />
          <p className={styles.qrcodeTip}>{t('settings.communityQrTip')}</p>
        </div>
      </div>

      {/* Social links + version history */}
      <div className={styles.socialSection}>
        <div className={styles.socialHeader}>
          <h3 className={styles.sectionTitle}>{t('settings.socialTitle')}</h3>
          <div className={styles.socialHeaderActions}>
            <a
              className={styles.versionHistoryBtn}
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => openExternal(e, DOCS_URL)}
              title={t('settings.socialDocs')}
            >
              <span className="codicon codicon-book" />
              {t('settings.socialDocs')}
            </a>
            <button
              type="button"
              className={styles.versionHistoryBtn}
              onClick={() => setShowChangelog(true)}
              title={t('settings.versionHistoryDesc')}
            >
              <span className="codicon codicon-history" />
              {t('settings.versionHistory')}
            </button>
          </div>
        </div>

        <div className={styles.socialRow}>
          <a
            className={styles.socialChip}
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => openExternal(e, GITHUB_URL)}
            title={t('settings.socialGithub')}
            aria-label={t('settings.socialGithub')}
          >
            <BrandIcon path={GITHUB_PATH} />
          </a>
          <a
            className={styles.socialChip}
            href={X_URL}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => openExternal(e, X_URL)}
            title={t('settings.socialX')}
            aria-label={t('settings.socialX')}
          >
            <BrandIcon path={X_PATH} />
          </a>
          <a
            className={`${styles.socialChip} ${styles.socialChipZhihu}`}
            href={ZHIHU_URL}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => openExternal(e, ZHIHU_URL)}
            title={t('settings.socialZhihu')}
            aria-label={t('settings.socialZhihu')}
          >
            <BrandIcon path={ZHIHU_PATH} />
          </a>
          <a
            className={`${styles.socialChip} ${styles.socialChipXiaohongshu}`}
            href={XIAOHONGSHU_URL}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => openExternal(e, XIAOHONGSHU_URL)}
            title={t('settings.socialXiaohongshu')}
            aria-label={t('settings.socialXiaohongshu')}
          >
            <BrandIcon path={XIAOHONGSHU_PATH} />
          </a>
          <div className={styles.douyinChip}>
            <button
              type="button"
              className={`${styles.socialChip} ${styles.socialChipDouyin}`}
              onClick={handleCopyDouyinId}
              title={t('settings.socialDouyin')}
              aria-label={t('settings.socialDouyin')}
              aria-describedby="douyin-popover"
            >
              <BrandIcon path={DOUYIN_PATH} />
            </button>
            <div className={styles.douyinPopover} id="douyin-popover" role="tooltip">
              <img
                src={douyinImage}
                alt={t('settings.douyinQrAlt')}
                className={styles.douyinPopoverImage}
              />
              <p className={styles.douyinPopoverTip}>{t('settings.douyinId')}</p>
            </div>
          </div>
          <a
            className={`${styles.socialChip} ${styles.socialChipYoutube}`}
            href={YOUTUBE_URL}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => openExternal(e, YOUTUBE_URL)}
            title={t('settings.socialYoutube')}
            aria-label={t('settings.socialYoutube')}
          >
            <BrandIcon path={YOUTUBE_PATH} />
          </a>
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
