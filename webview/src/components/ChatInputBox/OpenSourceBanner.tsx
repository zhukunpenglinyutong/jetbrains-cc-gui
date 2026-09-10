import type { TFunction } from 'i18next';
import { openBrowser, GITHUB_REPO_URL } from '../../utils/bridge';

/**
 * OpenSourceBanner - Open source banner
 * Displays the open source star/dismiss banner
 */
export const OpenSourceBanner = ({
  show,
  onDismiss,
  t,
}: {
  show?: boolean;
  onDismiss?: () => void;
  t: TFunction;
}) => {
  if (!show) {
    return null;
  }

  return (
    <div className="open-source-banner">
      <span className="banner-text">{t('chat.openSourceBanner')}</span>
      <button
        type="button"
        className="banner-star"
        aria-label={t('chat.openSourceBannerStarAria')}
        onClick={(e) => {
          e.stopPropagation();
          openBrowser(GITHUB_REPO_URL);
        }}
      >
        <svg className="star-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
        </svg>
        <span className="banner-star-text">{t('chat.openSourceBannerStar')}</span>
      </button>
      <button
        className="banner-close"
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss?.();
        }}
      >
        &#x2715;
      </button>
    </div>
  );
};

export default OpenSourceBanner;
