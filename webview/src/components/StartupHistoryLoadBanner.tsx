import { useTranslation } from 'react-i18next';
import type { StartupHistoryLoadState } from '../types/startupHistory';
import styles from './StartupHistoryLoadBanner.module.less';

interface StartupHistoryLoadBannerProps {
  state: StartupHistoryLoadState | null;
  currentSessionId: string | null;
}

const iconByStatus: Record<StartupHistoryLoadState['status'], string> = {
  unloaded: 'codicon-history',
  loading: 'codicon-loading',
  loaded: 'codicon-check',
  timeout: 'codicon-clock',
  cancelled: 'codicon-circle-slash',
  failed: 'codicon-error',
};

export function StartupHistoryLoadBanner({ state, currentSessionId }: StartupHistoryLoadBannerProps) {
  const { t } = useTranslation();
  if (!state || !currentSessionId || state.sessionId !== currentSessionId) return null;

  const load = () => window.sendToJava?.('load_restored_history:');
  const cancel = () => window.sendToJava?.(`cancel_restored_history:${state.requestId}`);
  const messageKey = `startupHistory.${state.status}`;

  return (
    <div
      className={`${styles.banner} ${styles[state.status] ?? ''}`}
      role={state.status === 'failed' || state.status === 'timeout' ? 'alert' : 'status'}
      title={state.message}
    >
      <span className={`codicon ${iconByStatus[state.status]} ${styles.icon}`} aria-hidden="true" />
      <span className={styles.message}>
        {t(messageKey, { count: state.messageCount })}
      </span>
      <span className={styles.actions}>
        {state.status === 'loading' ? (
          <button type="button" className={styles.button} onClick={cancel}>
            <span className="codicon codicon-stop-circle" aria-hidden="true" />
            {t('startupHistory.cancel')}
          </button>
        ) : state.status === 'unloaded' || state.retryable ? (
          <button type="button" className={styles.button} onClick={load}>
            <span className={`codicon ${state.status === 'unloaded' ? 'codicon-cloud-download' : 'codicon-refresh'}`} aria-hidden="true" />
            {t(state.status === 'unloaded' ? 'startupHistory.load' : 'startupHistory.retry')}
          </button>
        ) : null}
      </span>
    </div>
  );
}
