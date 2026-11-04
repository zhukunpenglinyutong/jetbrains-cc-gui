import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import type { StartupHistoryLoadState } from '../types/startupHistory';
import styles from './StartupHistoryLoadBanner.module.less';

interface StartupHistoryLoadBannerProps {
  state: StartupHistoryLoadState | null;
  currentSessionId: string | null;
}

const SUPERSEDED_ERROR_CODE = 'HISTORY_LOAD_SUPERSEDED';

const iconByStatus: Record<StartupHistoryLoadState['status'], string> = {
  unloaded: 'codicon-history',
  loading: 'codicon-loading',
  loaded: 'codicon-check',
  missing: 'codicon-info',
  timeout: 'codicon-clock',
  cancelled: 'codicon-circle-slash',
  failed: 'codicon-error',
};

export function StartupHistoryLoadBanner({ state, currentSessionId }: StartupHistoryLoadBannerProps) {
  const { t } = useTranslation();
  const [dismissedGeneration, setDismissedGeneration] = useState<string | null>(null);
  const generationKey = state ? `${state.sessionId}:${state.generation}` : '';
  useEffect(() => {
    if (state?.status !== 'loaded' && state?.status !== 'missing') return;
    const timer = window.setTimeout(() => setDismissedGeneration(generationKey), 3000);
    return () => window.clearTimeout(timer);
  }, [generationKey, state?.status]);
  if (!state || (state.sessionId !== currentSessionId && !(state.status === 'missing' && !currentSessionId))
    || ((state.status === 'loaded' || state.status === 'missing') && dismissedGeneration === generationKey)) return null;

  const load = () => window.sendToJava?.('load_restored_history:');
  const cancel = () => window.sendToJava?.(`cancel_restored_history:${state.requestId}`);
  // Newer live work outranked the restore; nothing failed, so say so instead of raising an alert.
  const superseded = state.status === 'failed' && state.errorCode === SUPERSEDED_ERROR_CODE;
  const messageKey = superseded ? 'startupHistory.superseded' : `startupHistory.${state.status}`;

  return (
    <div
      className={`${styles.banner} ${superseded ? '' : styles[state.status] ?? ''}`}
      role={!superseded && (state.status === 'failed' || state.status === 'timeout') ? 'alert' : 'status'}
      title={state.message}
    >
      <span className={`codicon ${superseded ? 'codicon-info' : iconByStatus[state.status]} ${styles.icon}`} aria-hidden="true" />
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
