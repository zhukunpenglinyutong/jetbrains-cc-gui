import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

interface PermissionsSectionProps {
  codexSandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexSandboxSource?: string;
  codexSandboxDesired?: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexSandboxEffective?: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexSandboxConflict?: boolean;
  onCodexSandboxModeChange: (mode: 'read-only' | 'workspace-write' | 'danger-full-access') => void;
}

const PermissionsSection = ({
  codexSandboxMode,
  codexSandboxSource = 'default',
  codexSandboxDesired = codexSandboxMode,
  codexSandboxEffective = codexSandboxMode,
  codexSandboxConflict = false,
  onCodexSandboxModeChange,
}: PermissionsSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.permissions')}</h3>
      <p className={styles.sectionDesc}>{t('settings.codexPermissionsDesc', { defaultValue: t('settings.permissionsDesc') })}</p>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <span className="codicon codicon-shield" />
          <span>{t('settings.permissionsPanel.codexSandboxTitle', { defaultValue: 'Codex Sandbox Mode' })}</span>
        </div>
        <p className={styles.panelDesc}>{t('settings.permissionsPanel.codexSandboxDesc', { defaultValue: 'Control system access boundaries when Codex executes commands.' })}</p>
        <small className={styles.hint}>
          {t('settings.permissionsPanel.source', { defaultValue: 'Source: {{source}}', source: codexSandboxSource })}
        </small>
        <small className={styles.hint}>
          {t('settings.permissionsPanel.desired', { defaultValue: 'Desired: {{mode}}', mode: codexSandboxDesired })}
          {' · '}
          {t('settings.permissionsPanel.effective', { defaultValue: 'Effective: {{mode}}', mode: codexSandboxEffective })}
        </small>
        {codexSandboxConflict && (
          <small className={styles.hint} role="alert">
            {t('settings.permissionsPanel.conflict', { defaultValue: 'Native policy rejected the requested access range.' })}
          </small>
        )}

        <div className={styles.options}>
          <label className={styles.option}>
            <input
              type="radio"
              name="codex-sandbox-mode"
              value="read-only"
              checked={codexSandboxMode === 'read-only'}
              onChange={() => onCodexSandboxModeChange('read-only')}
            />
            <div>
              <div className={styles.optionTitle}>{t('settings.permissionsPanel.readOnlyTitle', { defaultValue: 'Read only' })}</div>
              <div className={styles.optionDesc}>{t('settings.permissionsPanel.readOnlyDesc', { defaultValue: 'Inspect files without writing to the workspace.' })}</div>
            </div>
          </label>
          <label className={styles.option}>
            <input
              type="radio"
              name="codex-sandbox-mode"
              value="workspace-write"
              checked={codexSandboxMode === 'workspace-write'}
              onChange={() => onCodexSandboxModeChange('workspace-write')}
            />
            <div>
              <div className={styles.optionTitle}>{t('settings.permissionsPanel.workspaceWriteTitle', { defaultValue: 'workspace-write' })}</div>
              <div className={styles.optionDesc}>{t('settings.permissionsPanel.workspaceWriteDesc', { defaultValue: 'Read/write is limited to the workspace.' })}</div>
            </div>
          </label>

          <label className={styles.option}>
            <input
              type="radio"
              name="codex-sandbox-mode"
              value="danger-full-access"
              checked={codexSandboxMode === 'danger-full-access'}
              onChange={() => onCodexSandboxModeChange('danger-full-access')}
            />
            <div>
              <div className={styles.optionTitle}>{t('settings.permissionsPanel.fullAccessTitle', { defaultValue: 'danger-full-access' })}</div>
              <div className={styles.optionDesc}>{t('settings.permissionsPanel.fullAccessDesc', { defaultValue: 'Allows higher system access.' })}</div>
            </div>
          </label>
        </div>

        <small className={styles.hint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.permissionsPanel.hint', { defaultValue: 'This setting only affects Codex process sandboxing.' })}</span>
        </small>
      </div>
    </div>
  );
};

export default PermissionsSection;
