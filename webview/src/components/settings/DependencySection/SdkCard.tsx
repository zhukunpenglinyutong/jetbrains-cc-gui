import { useTranslation } from 'react-i18next';
import type {
  SdkId,
  SdkStatus,
  DependencyVersionInfo,
} from '../../../types/dependency';
import {
  buildVersionOptions,
  getRequestedVersion,
  getVersionAction,
} from './versioning';
import SdkActions from './SdkActions';
import SdkStatusBadges from './SdkStatusBadges';
import SdkVersionField from './SdkVersionField';
import styles from './style.module.less';

interface SdkCardProps {
  sdk: {
    id: SdkId;
    nameKey: string;
    description: string;
  };
  info?: SdkStatus;
  versionInfo?: DependencyVersionInfo;
  selectedVersion: string;
  isVersionLoading: boolean;
  isInstalling: boolean;
  isUninstalling: boolean;
  isUpdating: boolean;
  isAnyOperationInProgress: boolean;
  nodeAvailable: boolean | null;
  onVersionChange: (version: string) => void;
  onInstall: () => void;
  onUpdate: () => void;
  onUninstall: () => void;
}

const SdkCard = ({
  sdk,
  info,
  versionInfo,
  selectedVersion,
  isVersionLoading,
  isInstalling,
  isUninstalling,
  isUpdating,
  isAnyOperationInProgress,
  nodeAvailable,
  onVersionChange,
  onInstall,
  onUpdate,
  onUninstall,
}: SdkCardProps) => {
  const { t } = useTranslation();
  const installed = info?.status === 'installed';
  const versionOptions = buildVersionOptions({
    availableVersions: versionInfo?.versions,
    fallbackVersions: versionInfo?.fallbackVersions,
    installedVersion: info?.installedVersion,
  });
  const targetVersion = getRequestedVersion(selectedVersion);
  const targetVersionLabel = targetVersion
    ? t('settings.dependency.targetVersionValue', { version: `v${targetVersion}` })
    : t('settings.dependency.targetVersion');
  const action = getVersionAction({
    installed,
    installedVersion: info?.installedVersion,
    requestedVersion: targetVersion,
  });

  return (
    <div className={styles.sdkCard}>
      <div className={styles.sdkHeader}>
        <div className={styles.sdkInfo}>
          <div className={styles.sdkName}>
            <span className={`codicon ${installed ? 'codicon-check' : 'codicon-package'}`} />
            <span>{t(sdk.nameKey)}</span>
            <SdkStatusBadges
              installed={installed}
              installedVersion={info?.installedVersion}
              latestVersion={info?.latestVersion}
              hasUpdate={info?.hasUpdate}
            />
          </div>
          <div className={styles.sdkDescription}>{t(sdk.description)}</div>
          <div className={styles.versionControls}>
            <div className={styles.versionToolbar}>
              <SdkVersionField
                selectedVersion={selectedVersion}
                versionOptions={versionOptions}
                isVersionLoading={isVersionLoading}
                isAnyOperationInProgress={isAnyOperationInProgress}
                targetVersionLabel={targetVersionLabel}
                onVersionChange={onVersionChange}
              />
              <SdkActions
                installed={installed}
                targetVersion={targetVersion}
                action={action}
                isInstalling={isInstalling}
                isUninstalling={isUninstalling}
                isUpdating={isUpdating}
                isAnyOperationInProgress={isAnyOperationInProgress}
                nodeAvailable={nodeAvailable}
                onInstall={onInstall}
                onUpdate={onUpdate}
                onUninstall={onUninstall}
              />
            </div>
            {isVersionLoading && (
              <div className={styles.versionLoadingHint}>
                <span className="codicon codicon-loading codicon-modifier-spin" />
                <span>{t('settings.dependency.loadingVersions')}</span>
              </div>
            )}
            <div className={styles.versionMeta}>
              {info?.installedVersion && (
                <span>{t('settings.dependency.installedVersion', { version: `v${info.installedVersion}` })}</span>
              )}
              {versionInfo?.latestVersion && (
                <span>{t('settings.dependency.latestStableVersion', { version: `v${versionInfo.latestVersion}` })}</span>
              )}
            </div>
            {versionInfo?.source === 'fallback' && (
              <div className={styles.versionHint}>
                {t('settings.dependency.versionSourceFallback')}
              </div>
            )}
            {installed && action === 'rollback' && (
              <div className={styles.rollbackHint}>
                {t('settings.dependency.rollbackWarning')}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Install path info */}
      {installed && info?.installPath && (
        <div className={styles.installPath}>
          <span className="codicon codicon-folder" />
          <span>{info.installPath}</span>
        </div>
      )}
    </div>
  );
};

export default SdkCard;
