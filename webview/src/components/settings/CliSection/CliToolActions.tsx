import { useTranslation } from 'react-i18next';
import {
  type CliToolDefinition,
  type CliToolId,
} from '../../../types/cliTool';
import styles from './style.module.less';

interface CliVisibilityToggleProps {
  hidden: boolean;
  label: string;
  onToggle: () => void;
}

/** Eye toggle controlling whether the tool appears in the provider switcher. */
const CliVisibilityToggle = ({ hidden, label, onToggle }: CliVisibilityToggleProps) => (
  <button
    type="button"
    className={styles.iconBtn}
    onClick={onToggle}
    data-tooltip={label}
    title={label}
    aria-label={label}
    aria-pressed={hidden}
  >
    <span className={`codicon ${hidden ? 'codicon-eye-closed' : 'codicon-eye'}`} />
  </button>
);

interface CliInstalledActionsProps {
  tool: CliToolDefinition;
  onOpenInstall: (id: CliToolId) => void;
  onOpenDocs: (url: string) => void;
}

/** Installed state: status badge plus how-to-install and docs buttons. */
const CliInstalledActions = ({ tool, onOpenInstall, onOpenDocs }: CliInstalledActionsProps) => {
  const { t } = useTranslation();
  const howToInstallLabel = t('settings.cli.howToInstall');
  const openDocsLabel = t('settings.cli.installDialog.openDocs');

  return (
    <>
      <span className={`${styles.statusBadge} ${styles.ok}`}>
        <span className="codicon codicon-check" aria-hidden="true" />
        {t('settings.cli.status.installed')}
      </span>
      <span className={styles.divider} aria-hidden="true" />
      <div className={styles.actionButtons}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => onOpenInstall(tool.id)}
          data-tooltip={howToInstallLabel}
          title={howToInstallLabel}
          aria-label={howToInstallLabel}
        >
          <span className="codicon codicon-book" />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => onOpenDocs(tool.docsUrl)}
          data-tooltip={openDocsLabel}
          title={openDocsLabel}
          aria-label={openDocsLabel}
        >
          <span className="codicon codicon-link-external" />
        </button>
      </div>
    </>
  );
};

interface CliMissingActionsProps {
  tool: CliToolDefinition;
  onOpenInstall: (id: CliToolId) => void;
}

/** Missing state: status badge plus primary install-guide button. */
const CliMissingActions = ({ tool, onOpenInstall }: CliMissingActionsProps) => {
  const { t } = useTranslation();

  return (
    <>
      <span className={`${styles.statusBadge} ${styles.missing}`}>
        {t('settings.cli.status.notInstalled')}
      </span>
      <button
        type="button"
        className={styles.primaryBtn}
        onClick={() => onOpenInstall(tool.id)}
      >
        <span className="codicon codicon-desktop-download" aria-hidden="true" />
        {t('settings.cli.viewInstallGuide')}
      </button>
    </>
  );
};

interface CliToolActionsProps {
  tool: CliToolDefinition;
  installed: boolean;
  switcherHidden: boolean;
  visibilityLabel: string;
  onToggleSwitcherVisibility: (id: CliToolId, hidden: boolean) => void;
  onOpenInstall: (id: CliToolId) => void;
  onOpenDocs: (url: string) => void;
}

/** Action row of a CLI tool card: switcher visibility toggle plus install-state actions. */
const CliToolActions = ({
  tool,
  installed,
  switcherHidden,
  visibilityLabel,
  onToggleSwitcherVisibility,
  onOpenInstall,
  onOpenDocs,
}: CliToolActionsProps) => (
  <div className={styles.cliActions}>
    <CliVisibilityToggle
      hidden={switcherHidden}
      label={visibilityLabel}
      onToggle={() => onToggleSwitcherVisibility(tool.id, !switcherHidden)}
    />
    {installed ? (
      <CliInstalledActions
        tool={tool}
        onOpenInstall={onOpenInstall}
        onOpenDocs={onOpenDocs}
      />
    ) : (
      <CliMissingActions tool={tool} onOpenInstall={onOpenInstall} />
    )}
  </div>
);

export default CliToolActions;
