import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openBrowser } from '../../../utils/bridge';
import styles from './style.module.less';
import type { DshStatusPayload } from './dshTypes';

interface DshMoreMenuProps {
  busy: boolean;
  status: DshStatusPayload | null;
  origin: string;
  canOpenWebUi: boolean;
  canStop: boolean;
  onStopHost: () => void;
  onToggleAutoStart: (next: boolean) => void;
}

/**
 * "More actions" dropdown of the DSH host connection card: open web UI,
 * stop a plugin-spawned host, and the auto-start toggle. Closes on outside
 * click, Escape (returning focus to the trigger), and focus leaving the menu.
 */
const DshMoreMenu = ({
  busy,
  status,
  origin,
  canOpenWebUi,
  canStop,
  onStopHost,
  onToggleAutoStart,
}: DshMoreMenuProps) => {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

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

  const moreActionsLabel = t('settings.cli.dsh.moreActions');

  return (
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
                setMenuOpen(false);
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
                onStopHost();
                setMenuOpen(false);
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
              onChange={(e) => onToggleAutoStart(e.target.checked)}
            />
            <span>{t('settings.cli.dsh.autoStart')}</span>
          </label>
        </div>
      )}
    </div>
  );
};

export default DshMoreMenu;
