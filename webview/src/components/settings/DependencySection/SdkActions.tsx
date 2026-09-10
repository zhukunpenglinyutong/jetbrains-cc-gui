import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { VersionAction } from './versioning';
import styles from './style.module.less';

interface SdkActionsProps {
  installed: boolean;
  targetVersion?: string;
  action: VersionAction;
  isInstalling: boolean;
  isUninstalling: boolean;
  isUpdating: boolean;
  isAnyOperationInProgress: boolean;
  nodeAvailable: boolean | null;
  onInstall: () => void;
  onUpdate: () => void;
  onUninstall: () => void;
}

const resolveActionLabel = (
  t: TFunction,
  installed: boolean,
  targetVersion: string | undefined,
  action: VersionAction,
): string => {
  if (!installed) {
    return targetVersion
      ? t('settings.dependency.installVersion', { version: `v${targetVersion}` })
      : t('settings.dependency.install');
  }

  if (!targetVersion || action === 'current') {
    return t('settings.dependency.currentVersionAction');
  }

  if (action === 'rollback') {
    return t('settings.dependency.rollbackToVersion', { version: `v${targetVersion}` });
  }

  return t('settings.dependency.updateToVersion', { version: `v${targetVersion}` });
};

interface InstallButtonProps {
  label: string;
  isInstalling: boolean;
  disabled: boolean;
  onInstall: () => void;
}

const InstallButton = ({ label, isInstalling, disabled, onInstall }: InstallButtonProps) => {
  const { t } = useTranslation();

  return (
    <button
      className={`${styles.installBtn} ${isInstalling ? styles.installing : ''}`}
      onClick={onInstall}
      disabled={disabled}
    >
      {isInstalling ? (
        <>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('settings.dependency.installing')}</span>
        </>
      ) : (
        <>
          <span className="codicon codicon-cloud-download" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
};

interface UpdateButtonProps {
  label: string;
  isUpdating: boolean;
  disabled: boolean;
  onUpdate: () => void;
}

const UpdateButton = ({ label, isUpdating, disabled, onUpdate }: UpdateButtonProps) => {
  const { t } = useTranslation();

  return (
    <button
      className={styles.updateBtn}
      onClick={onUpdate}
      disabled={disabled}
    >
      {isUpdating ? (
        <>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('settings.dependency.updating')}</span>
        </>
      ) : (
        <>
          <span className="codicon codicon-sync" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
};

interface UninstallButtonProps {
  isUninstalling: boolean;
  disabled: boolean;
  onUninstall: () => void;
}

const UninstallButton = ({ isUninstalling, disabled, onUninstall }: UninstallButtonProps) => {
  const { t } = useTranslation();

  return (
    <button
      className={styles.uninstallBtn}
      onClick={onUninstall}
      disabled={disabled}
    >
      {isUninstalling ? (
        <>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('settings.dependency.uninstalling')}</span>
        </>
      ) : (
        <>
          <span className="codicon codicon-trash" />
          <span>{t('settings.dependency.uninstall')}</span>
        </>
      )}
    </button>
  );
};

const SdkActions = ({
  installed,
  targetVersion,
  action,
  isInstalling,
  isUninstalling,
  isUpdating,
  isAnyOperationInProgress,
  nodeAvailable,
  onInstall,
  onUpdate,
  onUninstall,
}: SdkActionsProps) => {
  const { t } = useTranslation();
  const actionLabel = resolveActionLabel(t, installed, targetVersion, action);
  // Only allow one operation at a time (install, uninstall, or update)
  const updateDisabled = isAnyOperationInProgress || nodeAvailable === false || action === 'current';

  return (
    <div className={styles.sdkActions}>
      {!installed ? (
        <InstallButton
          label={actionLabel}
          isInstalling={isInstalling}
          disabled={isAnyOperationInProgress || nodeAvailable === false}
          onInstall={onInstall}
        />
      ) : (
        <>
          <UpdateButton
            label={actionLabel}
            isUpdating={isUpdating}
            disabled={updateDisabled}
            onUpdate={onUpdate}
          />
          <UninstallButton
            isUninstalling={isUninstalling}
            disabled={isAnyOperationInProgress}
            onUninstall={onUninstall}
          />
        </>
      )}
    </div>
  );
};

export default SdkActions;
