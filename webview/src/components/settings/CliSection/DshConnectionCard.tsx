import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openBrowser } from '../../../utils/bridge';
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

interface DshStatusPayload {
  success?: boolean;
  installed?: boolean;
  version?: string;
  bin?: string;
  origin?: string;
  hostRunning?: boolean;
  ownership?: 'spawned' | 'adopted';
  error?: string;
  describe?: {
    version?: string;
    provider?: string;
    model?: string;
    attachedSessions?: number;
  };
  settings?: {
    bin?: string;
    host?: string;
    port?: number;
    autoStart?: boolean;
  };
}

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
  const [menuOpen, setMenuOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

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

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const menu = menuRef.current;
    const onMouseDown = (event: MouseEvent) => {
      if (menu && !menu.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (menu && !menu.contains(event.relatedTarget as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    menu?.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
      menu?.removeEventListener('focusout', onFocusOut);
    };
  }, [menuOpen]);

  const installed = status?.installed === true;
  const running = status?.hostRunning === true;
  const origin = status?.origin || '';
  const ownership = status?.ownership;

  let stateKey: 'checking' | 'notInstalled' | 'notRunning' | 'connected';
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

  const stateBadgeClass =
    stateKey === 'connected' ? styles.ok : stateKey === 'checking' ? '' : styles.missing;

  const canStart = (stateKey === 'notRunning' || stateKey === 'notInstalled') && installed !== false;
  const canOpenWebUi = stateKey === 'connected' && Boolean(origin);
  const canStop = stateKey === 'connected' && ownership === 'spawned';
  const moreActionsLabel = t('settings.cli.dsh.moreActions');

  return (
    <div
      className={`${styles.cliCard} ${styles.dshCard} ${nested ? styles.nestedCard : ''}`}
      data-testid="dsh-host-card"
    >
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

      <div className={styles.cliActions}>
        <span className={`${styles.statusBadge} ${stateBadgeClass}`}>
          {busy && <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />}
          {t(`settings.cli.dsh.state.${stateKey}`)}
          {stateKey === 'connected' && ownership === 'adopted' && (
            <span title={t('settings.cli.dsh.adoptedHint')}> · {t('settings.cli.dsh.adopted')}</span>
          )}
        </span>

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

        <div className={styles.moreMenu} ref={menuRef}>
          <button
            type="button"
            ref={menuButtonRef}
            className={styles.menuButton}
            onClick={() => setMenuOpen((open) => !open)}
            title={moreActionsLabel}
            aria-label={moreActionsLabel}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls="dsh-more-menu"
          >
            <span className="codicon codicon-ellipsis" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div
              id="dsh-more-menu"
              className={styles.dropdownMenu}
              role="group"
              aria-label={moreActionsLabel}
              data-testid="dsh-more-menu"
            >
              {canOpenWebUi && (
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    openBrowser(origin);
                    closeMenu();
                  }}
                >
                  <span className="codicon codicon-globe" aria-hidden="true" />
                  {t('settings.cli.dsh.openWebUi')}
                </button>
              )}
              {canStop && (
                <button
                  type="button"
                  className={`${styles.menuItem} ${styles.danger}`}
                  disabled={busy}
                  onClick={() => {
                    request('stop_dsh_host');
                    closeMenu();
                  }}
                >
                  <span className="codicon codicon-debug-stop" aria-hidden="true" />
                  {t('settings.cli.dsh.stopHost')}
                </button>
              )}
              {(canOpenWebUi || canStop) && <div className={styles.menuDivider} aria-hidden="true" />}
              <label
                className={styles.menuCheckItem}
                title={status ? undefined : t('settings.cli.dsh.state.checking')}
              >
                <input
                  type="checkbox"
                  checked={status?.settings?.autoStart !== false}
                  disabled={!status}
                  onChange={(e) => toggleAutoStart(e.target.checked)}
                />
                <span>{t('settings.cli.dsh.autoStart')}</span>
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DshConnectionCard;
