import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import type { DshStateKey } from './dshTypes';

interface DshStatusBadgeProps {
  busy: boolean;
  stateKey: DshStateKey;
  ownership?: 'spawned' | 'adopted';
}

/** Connection-state badge with busy spinner and adopted-host suffix. */
const DshStatusBadge = ({ busy, stateKey, ownership }: DshStatusBadgeProps) => {
  const { t } = useTranslation();

  const stateBadgeClass =
    stateKey === 'connected' ? styles.ok : stateKey === 'checking' ? '' : styles.missing;

  return (
    <span className={`${styles.statusBadge} ${stateBadgeClass}`}>
      {busy && <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />}
      {t(`settings.cli.dsh.state.${stateKey}`)}
      {stateKey === 'connected' && ownership === 'adopted' && (
        <span title={t('settings.cli.dsh.adoptedHint')}> · {t('settings.cli.dsh.adopted')}</span>
      )}
    </span>
  );
};

export default DshStatusBadge;
