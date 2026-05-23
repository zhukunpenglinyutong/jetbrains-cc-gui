import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import {
  DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  clampPermissionDialogTimeoutSeconds,
} from '../../../utils/permissionDialogTimeout';

export interface PermissionDialogTimeoutSettingProps {
  permissionDialogTimeoutSeconds?: number;
  onPermissionDialogTimeoutChange?: (seconds: number) => void;
}

export function PermissionDialogTimeoutSetting({
  permissionDialogTimeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  onPermissionDialogTimeoutChange = () => {},
}: PermissionDialogTimeoutSettingProps) {
  const { t } = useTranslation();
  const [timeoutInputValue, setTimeoutInputValue] = useState(String(permissionDialogTimeoutSeconds));

  useEffect(() => {
    setTimeoutInputValue(String(permissionDialogTimeoutSeconds));
  }, [permissionDialogTimeoutSeconds]);

  const commitTimeout = () => {
    const clamped = clampPermissionDialogTimeoutSeconds(timeoutInputValue);
    onPermissionDialogTimeoutChange(clamped);
    setTimeoutInputValue(String(clamped));
  };

  return (
    <div className={styles.streamingSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-clock" />
        <span className={styles.fieldLabel}>{t('settings.basic.permissionDialogTimeout.label')}</span>
      </div>
      <div className={`${styles.nodePathInputWrapper} ${styles.timeoutInputWrapper}`}>
        <input
          type="number"
          className={styles.nodePathInput}
          aria-label={t('settings.basic.permissionDialogTimeout.label')}
          min={MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS}
          max={MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS}
          value={timeoutInputValue}
          onChange={(e) => {
            setTimeoutInputValue(e.target.value);
          }}
          onBlur={commitTimeout}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitTimeout();
            }
          }}
        />
        <span className={styles.formHint}>{t('settings.basic.permissionDialogTimeout.unit')}</span>
      </div>
      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{t('settings.basic.permissionDialogTimeout.hint')}</span>
      </small>
    </div>
  );
}
