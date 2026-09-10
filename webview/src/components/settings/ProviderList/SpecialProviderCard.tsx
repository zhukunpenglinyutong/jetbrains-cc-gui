import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

const ICON_MR_8_STYLE: React.CSSProperties = { marginRight: '8px' };
const CLI_ACCOUNT_INFO_STYLE: React.CSSProperties = { marginTop: '4px', opacity: 0.8 };

interface SpecialProviderCardProps {
  iconClass: string;
  name: string;
  isActive: boolean;
  accountInfo?: string;
  onHelp: () => void;
  onRevoke: () => void;
  onEnable: () => void;
}

/**
 * Card for the built-in special providers (local settings file / CLI login).
 * These are pinned entries with authorize/revoke actions instead of
 * edit/delete/sort controls.
 */
export default function SpecialProviderCard({
  iconClass,
  name,
  isActive,
  accountInfo,
  onHelp,
  onRevoke,
  onEnable,
}: SpecialProviderCardProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`${styles.card} ${isActive ? styles.active : ''} ${styles.localProviderCard}`}
    >
      <div className={styles.cardInfo}>
        <div className={styles.name}>
          <span className={`codicon ${iconClass}`} style={ICON_MR_8_STYLE} />
          <span className={styles.nameText}>{name}</span>
          <button
            type="button"
            className={styles.nameInfoIcon}
            onClick={(e) => { e.stopPropagation(); onHelp(); }}
            title={t('settings.provider.whatIsThis')}
            aria-label={t('settings.provider.whatIsThis')}
          >
            <span className="codicon codicon-info" />
          </button>
        </div>
        {accountInfo && isActive && (
          <div className={styles.website} style={CLI_ACCOUNT_INFO_STYLE}>
            {accountInfo}
          </div>
        )}
      </div>

      <div className={styles.cardActions}>
        {isActive ? (
          <button
            className={styles.revokeButton}
            onClick={onRevoke}
          >
            <span className="codicon codicon-circle-slash" />
            {t('settings.provider.revokeAuthorization')}
          </button>
        ) : (
          <button
            className={styles.useButton}
            onClick={onEnable}
          >
            <span className="codicon codicon-play" />
            {t('settings.provider.authorizeAndEnable')}
          </button>
        )}
      </div>
    </div>
  );
}
