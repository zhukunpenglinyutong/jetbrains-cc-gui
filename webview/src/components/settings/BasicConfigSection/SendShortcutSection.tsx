import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

export interface SendShortcutSectionProps {
  sendShortcut: 'enter' | 'cmdEnter';
  onSendShortcutChange: (shortcut: 'enter' | 'cmdEnter') => void;
}

/** Send shortcut configuration (Enter vs Cmd+Enter card picker). */
export function SendShortcutSection({
  sendShortcut,
  onSendShortcutChange,
}: SendShortcutSectionProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.sendShortcutSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-keyboard" />
        <span className={styles.fieldLabel}>{t('settings.basic.sendShortcut.label')}</span>
      </div>
      <div className={styles.themeGrid}>
        <div
          className={`${styles.themeCard} ${sendShortcut === 'enter' ? styles.active : ''}`}
          onClick={() => onSendShortcutChange('enter')}
        >
          {sendShortcut === 'enter' && (
            <div className={styles.checkBadge}>
              <span className="codicon codicon-check" />
            </div>
          )}
          <div className={styles.themeCardTitle}>{t('settings.basic.sendShortcut.enter')}</div>
          <div className={styles.themeCardDesc}>{t('settings.basic.sendShortcut.enterDesc')}</div>
        </div>

        <div
          className={`${styles.themeCard} ${sendShortcut === 'cmdEnter' ? styles.active : ''}`}
          onClick={() => onSendShortcutChange('cmdEnter')}
        >
          {sendShortcut === 'cmdEnter' && (
            <div className={styles.checkBadge}>
              <span className="codicon codicon-check" />
            </div>
          )}
          <div className={styles.themeCardTitle}>{t('settings.basic.sendShortcut.cmdEnter')}</div>
          <div className={styles.themeCardDesc}>{t('settings.basic.sendShortcut.cmdEnterDesc')}</div>
        </div>
      </div>
    </div>
  );
}
