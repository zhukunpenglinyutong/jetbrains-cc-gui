import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import {
  MAX_GEMINI_IDLE_REAP_MINUTES,
  MIN_GEMINI_IDLE_REAP_MINUTES,
  clampGeminiIdleReapMinutes,
} from '../../../utils/geminiIdleReap';

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
 *
 * Persistence commits on blur / Enter (review fix M2 — same pattern as the
 * permission-dialog timeout field), never per keystroke: typing 30→45 must
 * not momentarily persist "4", an abandoned mid-edit previously left a 1–4
 * minute window that killed healthy 20-minute silent turns. The draft is
 * clamped to [0, 1440] on commit (a >2^31 value would be narrowed by Gson
 * getAsInt() on the Java side and could read as negative → 0 = silently
 * disabled); Escape reverts the draft to the last authoritative value.
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
  // What the input displays; only commit() turns it into a persisted value.
  const [draft, setDraft] = useState('');
  const label = t('settings.gemini.idleReapLabel');

  useEffect(() => {
    const previous = window.updateGeminiIdleReapMinutes;
    window.updateGeminiIdleReapMinutes = (dataOrStr: string) => {
      const parsed = parseMinutes(dataOrStr);
      if (parsed !== null) {
        setMinutes(parsed);
        setDraft(String(parsed));
      }
      previous?.(dataOrStr);
    };
    sendToJava('get_gemini_idle_reap_minutes');
    return () => {
      window.updateGeminiIdleReapMinutes = previous;
    };
  }, []);

  const commit = useCallback(() => {
    if (minutes === null) return;
    const clamped = clampGeminiIdleReapMinutes(draft);
    if (clamped === null) {
      // Blank / unparseable draft (abandoned or cleared edit): revert the
      // display to the authoritative value — never commit, and never flip a
      // disabled watchdog back to the default.
      setDraft(String(minutes));
      return;
    }
    setDraft(String(clamped));
    if (clamped !== minutes) {
      setMinutes(clamped);
      sendToJava(`set_gemini_idle_reap_minutes:${JSON.stringify({ geminiIdleReapMinutes: clamped })}`);
    }
  }, [draft, minutes]);

  const revert = useCallback(() => {
    if (minutes !== null) {
      setDraft(String(minutes));
    }
  }, [minutes]);

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
          min={MIN_GEMINI_IDLE_REAP_MINUTES}
          max={MAX_GEMINI_IDLE_REAP_MINUTES}
          step={1}
          value={draft}
          disabled={minutes === null}
          aria-label={label}
          title={t('settings.gemini.idleReapHelp')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              revert();
            }
          }}
        />
      </div>
    </div>
  );
};

export default GeminiIdleReapCard;
