import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import type { DshStateKey, DshStatusPayload } from './dshTypes';

interface DshCardHeaderProps {
  nested: boolean;
  status: DshStatusPayload | null;
  origin: string;
  stateKey: DshStateKey;
}

/** Icon, name, version badge, and meta line of the DSH host connection card. */
const DshCardHeader = ({ nested, status, origin, stateKey }: DshCardHeaderProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.cliMain}>
      <div className={styles.cliIcon}>
        <span className="codicon codicon-server-process" aria-hidden="true" />
      </div>
      <span
        className={styles.cliName}
        title={t(nested ? 'settings.cli.dsh.cardTitle' : 'settings.cli.dsh.groupTitle')}
      >
        {t(nested ? 'settings.cli.dsh.cardTitle' : 'settings.cli.dsh.groupTitle')}
      </span>
      {!nested && status?.version && (
        <span className={styles.versionBadge}>v{status.version}</span>
      )}
      <span
        className={styles.cliMeta}
        title={status?.error || origin || t('settings.cli.dsh.hint')}
      >
        {stateKey === 'connected' && origin
          ? `${origin} · ${status?.describe?.provider ?? ''}/${status?.describe?.model ?? ''}`
          : status?.error
            || (nested ? t('settings.cli.dsh.rowHint') : t('settings.cli.dsh.hint'))}
      </span>
    </div>
  );
};

export default DshCardHeader;
