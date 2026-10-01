import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import {
  DEFAULT_HISTORY_LOAD_TIMEOUT_SECONDS,
  MAX_HISTORY_LOAD_TIMEOUT_SECONDS,
  MIN_HISTORY_LOAD_TIMEOUT_SECONDS,
  clampHistoryLoadTimeoutSeconds,
} from '../../../utils/historyLoadTimeout';

interface HistoryLoadTimeoutSettingProps {
  seconds?: number;
  onChange?: (seconds: number) => void;
}

export function HistoryLoadTimeoutSetting({
  seconds = DEFAULT_HISTORY_LOAD_TIMEOUT_SECONDS,
  onChange = () => {},
}: HistoryLoadTimeoutSettingProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState(String(seconds));

  useEffect(() => setInput(String(seconds)), [seconds]);

  const commit = () => {
    const bounded = clampHistoryLoadTimeoutSeconds(input);
    setInput(String(bounded));
    onChange(bounded);
  };

  return (
    <div className={styles.streamingSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-clock" />
        <span className={styles.fieldLabel}>{t('settings.basic.historyLoadTimeout.label')}</span>
      </div>
      <div className={`${styles.nodePathInputWrapper} ${styles.timeoutInputWrapper}`}>
        <input
          type="number"
          className={styles.nodePathInput}
          aria-label={t('settings.basic.historyLoadTimeout.label')}
          min={MIN_HISTORY_LOAD_TIMEOUT_SECONDS}
          max={MAX_HISTORY_LOAD_TIMEOUT_SECONDS}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
        <span className={styles.formHint}>{t('settings.basic.historyLoadTimeout.unit')}</span>
      </div>
      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{t('settings.basic.historyLoadTimeout.hint')}</span>
      </small>
    </div>
  );
}
