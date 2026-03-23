import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

export interface EnvironmentTabProps {
  nodePath: string;
  onNodePathChange: (path: string) => void;
  onSaveNodePath: () => void;
  savingNodePath: boolean;
  nodeVersion?: string | null;
  minNodeVersion?: number;
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  onSaveWorkingDirectory?: () => void;
  savingWorkingDirectory?: boolean;
  trackerPath?: string;
  onTrackerPathChange?: (path: string) => void;
  onSaveTrackerPath?: () => void;
  savingTrackerPath?: boolean;
  trackerPathExists?: boolean;
}

const EnvironmentTab = ({
  nodePath,
  onNodePathChange,
  onSaveNodePath,
  savingNodePath,
  nodeVersion,
  minNodeVersion = 18,
  workingDirectory = '',
  onWorkingDirectoryChange = () => {},
  onSaveWorkingDirectory = () => {},
  savingWorkingDirectory = false,
  trackerPath = '',
  onTrackerPathChange = () => {},
  onSaveTrackerPath = () => {},
  savingTrackerPath = false,
  trackerPathExists,
}: EnvironmentTabProps) => {
  const { t } = useTranslation();

  // Parse the major version number
  const parseMajorVersion = (version: string | null | undefined): number => {
    if (!version) return 0;
    const versionStr = version.startsWith('v') ? version.substring(1) : version;
    const dotIndex = versionStr.indexOf('.');
    if (dotIndex > 0) {
      return parseInt(versionStr.substring(0, dotIndex), 10) || 0;
    }
    return parseInt(versionStr, 10) || 0;
  };

  const majorVersion = parseMajorVersion(nodeVersion);
  const isVersionTooLow = nodeVersion && majorVersion > 0 && majorVersion < minNodeVersion;

  return (
    <div className={styles.tabContent}>
      {/* Node.js path configuration */}
      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-terminal" />
          <span className={styles.fieldLabel}>{t('settings.basic.nodePath.label')}</span>
          {nodeVersion && (
            <span className={`${styles.versionBadge} ${isVersionTooLow ? styles.versionBadgeError : styles.versionBadgeOk}`}>
              {nodeVersion}
            </span>
          )}
        </div>
        {isVersionTooLow && (
          <div className={styles.versionWarning}>
            <span className="codicon codicon-warning" />
            {t('settings.basic.nodePath.versionTooLow', { minVersion: minNodeVersion })}
          </div>
        )}
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.nodePath.placeholder')}
            value={nodePath}
            onChange={(e) => onNodePathChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveNodePath}
            disabled={savingNodePath}
          >
            {savingNodePath && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>
            {t('settings.basic.nodePath.hint')} <code>{t('settings.basic.nodePath.hintCommand')}</code> {t('settings.basic.nodePath.hintText')}
          </span>
        </small>
      </div>

      {/* Working directory configuration */}
      <div className={styles.workingDirSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-folder" />
          <span className={styles.fieldLabel}>{t('settings.basic.workingDirectory.label')}</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.workingDirectory.placeholder')}
            value={workingDirectory}
            onChange={(e) => onWorkingDirectoryChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveWorkingDirectory}
            disabled={savingWorkingDirectory}
          >
            {savingWorkingDirectory && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>
            {t('settings.basic.workingDirectory.hint')}
          </span>
        </small>
      </div>
      {/* Bug tracker file configuration (F-008) */}
      <div className={styles.workingDirSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-bug" />
          <span className={styles.fieldLabel}>Bug Tracker File</span>
          {trackerPath && trackerPathExists !== undefined && (
            <span className={`${styles.versionBadge} ${trackerPathExists ? styles.versionBadgeOk : styles.versionBadgeError}`}>
              <span className={`codicon ${trackerPathExists ? 'codicon-check' : 'codicon-warning'}`} />
              {trackerPathExists ? ' Found' : ' Not found'}
            </span>
          )}
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder="e.g. D:\project\docs\TRACKER.md"
            value={trackerPath}
            onChange={(e) => onTrackerPathChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveTrackerPath}
            disabled={savingTrackerPath}
          >
            {savingTrackerPath && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>Path to bug tracker markdown file. Leave empty for auto-discovery.</span>
        </small>
      </div>
    </div>
  );
};

export default EnvironmentTab;
