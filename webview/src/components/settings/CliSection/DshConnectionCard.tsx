import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DshCardHeader from './DshCardHeader';
import DshMoreMenu from './DshMoreMenu';
import DshStatusBadge from './DshStatusBadge';
import type { DshStateKey, DshStatusPayload } from './dshTypes';
import styles from './style.module.less';

/**
 * DSH host connection card (Settings → CLI).
 *
 * Talks to the Java DshHostHandler:
 *   sendToJava('get_dsh_status')  → window.updateDshStatus(json)
 *   sendToJava('start_dsh_host')  → window.updateDshStatus(json)
 *   sendToJava('stop_dsh_host')   → window.updateDshStatus(json)
 *   sendToJava('save_dsh_settings:<json>') → persists {autoStart} etc.
 *
 * DSH (DeepSeek Harness) runs as one persistent local `dsh web` host; the
 * plugin adopts an already-running host and never kills adopted processes.
 */

const DSH_STATUS_TIMEOUT_MS = 30_000;

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

const parsePayload = (dataOrStr: string | DshStatusPayload): DshStatusPayload | null => {
  if (typeof dataOrStr !== 'string') {
    return dataOrStr && typeof dataOrStr === 'object' ? dataOrStr : null;
  }
  try {
    return JSON.parse(dataOrStr) as DshStatusPayload;
  } catch {
    return null;
  }
};

interface DshConnectionCardProps {
  /** Nested under the DeepSeek Harness group — role row, not a second product. */
  nested?: boolean;
}

const DshConnectionCard = ({ nested = false }: DshConnectionCardProps) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DshStatusPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const request = useCallback(
    (command: 'get_dsh_status' | 'start_dsh_host' | 'stop_dsh_host') => {
      clearPendingTimeout();
      setBusy(true);
      sendToJava(command);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setBusy(false);
      }, DSH_STATUS_TIMEOUT_MS);
    },
    [clearPendingTimeout],
  );

  useEffect(() => {
    const previous = window.updateDshStatus;
    window.updateDshStatus = (dataOrStr) => {
      clearPendingTimeout();
      const parsed = parsePayload(dataOrStr);
      if (parsed) {
        setStatus(parsed);
      }
      setBusy(false);
      previous?.(dataOrStr as string);
    };
    request('get_dsh_status');
    return () => {
      window.updateDshStatus = previous;
      clearPendingTimeout();
    };
  }, [request, clearPendingTimeout]);

  const toggleAutoStart = useCallback(
    (next: boolean) => {
      sendToJava(`save_dsh_settings:${JSON.stringify({ autoStart: next })}`);
      setStatus((prev) =>
        prev ? { ...prev, settings: { ...prev.settings, autoStart: next } } : prev,
      );
    },
    [],
  );

  const installed = status?.installed === true;
  const running = status?.hostRunning === true;
  const origin = status?.origin || '';
  const ownership = status?.ownership;

  let stateKey: DshStateKey;
  if (busy && !status) {
    stateKey = 'checking';
  } else if (status && installed === false) {
    stateKey = 'notInstalled';
  } else if (running) {
    stateKey = 'connected';
  } else if (status) {
    stateKey = 'notRunning';
  } else {
    stateKey = 'checking';
  }

  const canStart = (stateKey === 'notRunning' || stateKey === 'notInstalled') && installed !== false;
  const canOpenWebUi = stateKey === 'connected' && Boolean(origin);
  const canStop = stateKey === 'connected' && ownership === 'spawned';

  return (
    <div
      className={`${styles.cliCard} ${styles.dshCard} ${nested ? styles.nestedCard : ''}`}
      data-testid="dsh-host-card"
    >
      <DshCardHeader nested={nested} status={status} origin={origin} stateKey={stateKey} />

      <div className={styles.cliActions}>
        <DshStatusBadge busy={busy} stateKey={stateKey} ownership={ownership} />

        {canStart && (
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={busy}
            onClick={() => request('start_dsh_host')}
          >
            <span className="codicon codicon-play" aria-hidden="true" />
            {t('settings.cli.dsh.startHost')}
          </button>
        )}

        {!canStart && <span className={styles.divider} aria-hidden="true" />}

        <DshMoreMenu
          busy={busy}
          status={status}
          origin={origin}
          canOpenWebUi={canOpenWebUi}
          canStop={canStop}
          onStopHost={() => request('stop_dsh_host')}
          onToggleAutoStart={toggleAutoStart}
        />
      </div>
    </div>
  );
};

export default DshConnectionCard;
