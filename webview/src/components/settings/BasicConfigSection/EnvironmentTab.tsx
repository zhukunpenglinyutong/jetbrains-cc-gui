import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import type { EnvFilePathIssue, EnvFileState } from '../../../types/envFile';

export interface EnvironmentTabProps {
  nodePath: string;
  onNodePathChange: (path: string) => void;
  onSaveNodePath: () => void;
  savingNodePath: boolean;
  nodeVersion?: string | null;
  minNodeVersion?: number;
  claudeCliPath?: string;
  onClaudeCliPathChange?: (path: string) => void;
  onSaveClaudeCliPath?: () => void;
  savingClaudeCliPath?: boolean;
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  onSaveWorkingDirectory?: () => void;
  savingWorkingDirectory?: boolean;
  envFile?: string;
  onEnvFileChange?: (path: string) => void;
  onSaveEnvFile?: () => void;
  savingEnvFile?: boolean;
  /** Effective state reported by the backend; 'unknown' until it answers. */
  envFileState?: EnvFileState;
  /** Back to auto-discovery of <project>/.env. */
  onResetEnvFile?: () => void;
  /** Client-side rejection reason, translated here. */
  envFileError?: EnvFilePathIssue | null;
}

/** Icon + i18n key describing each effective state. */
const ENV_FILE_STATE_DISPLAY: Record<
  EnvFileState,
  { icon: string; labelKey: string; detailKey: string }
> = {
  notConfigured: {
    icon: 'codicon-settings-gear',
    labelKey: 'settings.basic.envFile.state.notConfigured',
    detailKey: 'settings.basic.envFile.state.notConfiguredDetail',
  },
  configured: {
    icon: 'codicon-file',
    labelKey: 'settings.basic.envFile.state.configured',
    detailKey: 'settings.basic.envFile.state.configuredDetail',
  },
  disabled: {
    icon: 'codicon-circle-slash',
    labelKey: 'settings.basic.envFile.state.disabled',
    detailKey: 'settings.basic.envFile.state.disabledDetail',
  },
  unknown: {
    icon: 'codicon-question',
    labelKey: 'settings.basic.envFile.state.unknown',
    detailKey: 'settings.basic.envFile.state.unknownDetail',
  },
};

const EnvironmentTab = ({
  nodePath,
  onNodePathChange,
  onSaveNodePath,
  savingNodePath,
  nodeVersion,
  minNodeVersion = 18,
  claudeCliPath = '',
  onClaudeCliPathChange = () => {},
  onSaveClaudeCliPath = () => {},
  savingClaudeCliPath = false,
  workingDirectory = '',
  onWorkingDirectoryChange = () => {},
  onSaveWorkingDirectory = () => {},
  savingWorkingDirectory = false,
  envFile = '',
  onEnvFileChange = () => {},
  onSaveEnvFile = () => {},
  savingEnvFile = false,
  envFileState = 'unknown',
  onResetEnvFile = () => {},
  envFileError = null,
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

  // Only ever read from a closed set of keys — no user value is interpolated
  // into markup.
  const envStateDisplay = ENV_FILE_STATE_DISPLAY[envFileState] ?? ENV_FILE_STATE_DISPLAY.unknown;

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

      {/* Custom Claude CLI path */}
      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-rocket" />
          <span className={styles.fieldLabel}>{t('settings.basic.claudeCliPath.label')}</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.claudeCliPath.placeholder')}
            value={claudeCliPath}
            onChange={(e) => onClaudeCliPathChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveClaudeCliPath}
            disabled={savingClaudeCliPath}
          >
            {savingClaudeCliPath && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.claudeCliPath.hint')}</span>
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

      {/* Environment file configuration */}
      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-key" />
          <span className={styles.fieldLabel}>{t('settings.basic.envFile.label')}</span>
          <span className={styles.projectLevelBadge}>
            {t('settings.basic.envFile.projectLevel')}
          </span>
        </div>
        {/* Effective state, straight from the backend. The draft field alone
            cannot tell "opted out" from "never configured" — both look empty. */}
        <small
          className={styles.envFileStateRow}
          data-testid="env-file-state"
          data-state={envFileState}
        >
          <span className={`codicon ${envStateDisplay.icon}`} />
          <span className={styles.envFileStateLabel}>{t(envStateDisplay.labelKey)}</span>
          <span className={styles.envFileStateDetail}>{t(envStateDisplay.detailKey)}</span>
        </small>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.envFile.placeholder')}
            value={envFile}
            onChange={(e) => onEnvFileChange((e.target as HTMLInputElement).value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveEnvFile}
            disabled={savingEnvFile}
          >
            {savingEnvFile && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <div className={styles.envFileActions}>
          <button
            type="button"
            className={styles.envFileResetBtn}
            onClick={onResetEnvFile}
            disabled={savingEnvFile}
            title={t('settings.basic.envFile.resetHint')}
          >
            <span className="codicon codicon-refresh" />
            {t('settings.basic.envFile.reset')}
          </button>
        </div>
        {envFileError && (
          <small className={styles.formHintError}>
            <span className="codicon codicon-error" />
            <span>{t(`settings.basic.envFile.error.${envFileError}`)}</span>
          </small>
        )}
        {!envFileError && (
          <small className={styles.formHint}>
            <span className="codicon codicon-info" />
            <span>{t('settings.basic.envFile.hint')}</span>
          </small>
        )}
      </div>
    </div>
  );
};

export default EnvironmentTab;
