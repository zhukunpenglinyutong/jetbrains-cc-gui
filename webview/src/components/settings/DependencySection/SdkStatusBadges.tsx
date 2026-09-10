import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

interface SdkStatusBadgesProps {
  installed: boolean;
  installedVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
}

const SdkStatusBadges = ({
  installed,
  installedVersion,
  latestVersion,
  hasUpdate,
}: SdkStatusBadgesProps) => {
  const { t } = useTranslation();

  return (
    <>
      {installed && installedVersion && (
        <span className={styles.versionBadge}>v{installedVersion}</span>
      )}
      {installed && hasUpdate && latestVersion && (
        <span className={styles.versionBadge}>→ v{latestVersion}</span>
      )}
      {hasUpdate && (
        <span className={styles.updateBadge}>
          {t('settings.dependency.updateAvailable')}
        </span>
      )}
    </>
  );
};

export default SdkStatusBadges;
