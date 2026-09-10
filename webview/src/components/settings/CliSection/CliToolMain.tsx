import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import type { CliToolDefinition } from '../../../types/cliTool';
import styles from './style.module.less';

interface CliToolMainProps {
  tool: CliToolDefinition;
  nested: boolean;
  installed: boolean;
  version?: string;
  name: string;
  meta: string;
  metaTitle: string;
}

/** Icon, name, badges, and meta line of a CLI tool card. */
const CliToolMain = ({
  tool,
  nested,
  installed,
  version,
  name,
  meta,
  metaTitle,
}: CliToolMainProps) => (
  <div className={styles.cliMain} title={metaTitle}>
    <div className={styles.cliIcon}>
      {nested ? (
        <span className="codicon codicon-terminal" aria-hidden="true" />
      ) : (
        <ProviderModelIcon providerId={tool.id} size={16} colored />
      )}
    </div>

    <span className={styles.cliName} title={name}>{name}</span>
    {installed && version && (
      <span className={styles.versionBadge}>v{version}</span>
    )}
    {!installed && (
      <span className={styles.binaryChip}>{tool.binaryName}</span>
    )}
    <span className={styles.cliMeta}>{meta}</span>
  </div>
);

export default CliToolMain;
