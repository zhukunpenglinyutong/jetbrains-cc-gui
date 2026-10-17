import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

interface SdkStatusBadgesProps {
  installed: boolean;
  installedVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  /** Runtime kind behind the dependency: TypeScript SDK or native CLI */
  runtimeKind?: 'sdk' | 'cli';
  /** Transport used by a CLI runtime (e.g. "app-server") */
  transport?: string;
}

const SdkStatusBadges = ({
  installed,
  installedVersion,
  latestVersion,
  hasUpdate,
  runtimeKind,
  transport,
}: SdkStatusBadgesProps) => {
  const { t } = useTranslation();

  return (
    <>
      {installed && runtimeKind === 'cli' && (
        <span className={styles.versionBadge}>
          {t('settings.dependency.cliTransportBadge', {
            transport: transport || 'app-server',
          })}
        </span>
      )}
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
