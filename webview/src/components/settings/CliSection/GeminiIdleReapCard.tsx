import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

/**
 * Gemini idle-reap window card (Settings → CLI, shown under the Gemini CLI row
 * when the CLI is installed).
 *
 * Talks to the Java settings chain (SettingsHandler → ProjectConfigHandler →
 * CodemossSettingsService):
 *   sendToJava('get_gemini_idle_reap_minutes')        → window.updateGeminiIdleReapMinutes(json)
 *   sendToJava('set_gemini_idle_reap_minutes:<json>') → echo via window.updateGeminiIdleReapMinutes(json)
 *
 * Payload shape: {"geminiIdleReapMinutes": <int>} — minutes of stdout silence
 * after which a Gemini turn is stopped automatically; 0 disables the watchdog.
 * Persistence is optimistic (same pattern as the boolean toggles): the input
 * updates local state and sends immediately; the authoritative echo from Java
 * re-syncs the value (Java clamps negatives to 0).
 */

interface IdleReapPayload {
  geminiIdleReapMinutes?: number;
}

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

const parseMinutes = (dataOrStr: string | IdleReapPayload): number | null => {
  let payload: IdleReapPayload | null;
  if (typeof dataOrStr === 'string') {
    try {
      payload = JSON.parse(dataOrStr) as IdleReapPayload;
    } catch {
      return null;
    }
  } else {
    payload = dataOrStr;
  }
  const value = payload?.geminiIdleReapMinutes;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
};

const GeminiIdleReapCard = () => {
  const { t } = useTranslation();
  // null = not yet answered by Java (input stays disabled until then)
  const [minutes, setMinutes] = useState<number | null>(null);
  const label = t('settings.gemini.idleReapLabel');

  useEffect(() => {
    const previous = window.updateGeminiIdleReapMinutes;
    window.updateGeminiIdleReapMinutes = (dataOrStr: string) => {
      const parsed = parseMinutes(dataOrStr);
      if (parsed !== null) {
        setMinutes(parsed);
      }
      previous?.(dataOrStr);
    };
    sendToJava('get_gemini_idle_reap_minutes');
    return () => {
      window.updateGeminiIdleReapMinutes = previous;
    };
  }, []);

  const handleChange = useCallback((raw: string) => {
    if (raw === '') {
      // Never persist mid-edit: an empty field must not become "0 = disabled".
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return;
    }
    setMinutes(parsed);
    sendToJava(`set_gemini_idle_reap_minutes:${JSON.stringify({ geminiIdleReapMinutes: parsed })}`);
  }, []);

  return (
    <div className={styles.cliCard} data-testid="gemini-idle-reap-card">
      <div className={styles.cliMain}>
        <div className={styles.cliIcon}>
          <span className="codicon codicon-watch" aria-hidden="true" />
        </div>
        <span className={styles.cliName} title={label}>
          {label}
        </span>
        <span className={styles.cliMeta} title={t('settings.gemini.idleReapHelp')}>
          {t('settings.gemini.idleReapHelp')}
        </span>
      </div>

      <div className={styles.cliActions}>
        {minutes === 0 && (
          <span className={`${styles.statusBadge} ${styles.missing}`}>
            {t('settings.gemini.idleReapDisabled')}
          </span>
        )}
        <input
          type="number"
          className={styles.idleReapInput}
          min={0}
          step={1}
          value={minutes === null ? '' : String(minutes)}
          disabled={minutes === null}
          aria-label={label}
          title={t('settings.gemini.idleReapHelp')}
          onChange={(e) => handleChange(e.target.value)}
        />
      </div>
    </div>
  );
};

export default GeminiIdleReapCard;
