import { useTranslation } from 'react-i18next';
import {
  type CliToolDefinition,
  type CliToolId,
  type CliToolStatus,
} from '../../../types/cliTool';
import CliToolMain from './CliToolMain';
import CliToolActions from './CliToolActions';
import styles from './style.module.less';

interface CliToolCardProps {
  tool: CliToolDefinition;
  status?: CliToolStatus;
  onOpenInstall: (id: CliToolId) => void;
  onOpenDocs: (url: string) => void;
  /** Hidden from the provider switcher dropdown */
  switcherHidden: boolean;
  onToggleSwitcherVisibility: (id: CliToolId, hidden: boolean) => void;
  /** Nested inside a product group — show a role label instead of repeating the product name. */
  nested?: boolean;
  displayName?: string;
}

const CliToolCard = ({
  tool,
  status,
  onOpenInstall,
  onOpenDocs,
  switcherHidden,
  onToggleSwitcherVisibility,
  nested = false,
  displayName,
}: CliToolCardProps) => {
  const { t } = useTranslation();
  const installed = status?.installed === true;
  const version = status?.version;
  const path = status?.path;
  const description = t(tool.descriptionKey);
  // Prefer path when installed; fall back to description for missing tools.
  const meta = installed && path ? path : description;
  const metaTitle = installed && path
    ? `${description}\n${path}`
    : description;
  const name = displayName ?? t(tool.nameKey);
  const visibilityLabel = switcherHidden
    ? t('settings.cli.visibility.show', { defaultValue: 'Show in provider switcher' })
    : t('settings.cli.visibility.hide', { defaultValue: 'Hide in provider switcher' });

  return (
    <div
      className={`${styles.cliCard} ${installed ? styles.installed : styles.missing} ${nested ? styles.nestedCard : ''} ${switcherHidden ? styles.switcherHidden : ''}`}
    >
      <CliToolMain
        tool={tool}
        nested={nested}
        installed={installed}
        version={version}
        name={name}
        meta={meta}
        metaTitle={metaTitle}
      />
      <CliToolActions
        tool={tool}
        installed={installed}
        switcherHidden={switcherHidden}
        visibilityLabel={visibilityLabel}
        onToggleSwitcherVisibility={onToggleSwitcherVisibility}
        onOpenInstall={onOpenInstall}
        onOpenDocs={onOpenDocs}
      />
    </div>
  );
};

export default CliToolCard;
