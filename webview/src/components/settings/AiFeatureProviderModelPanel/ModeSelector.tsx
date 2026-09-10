import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

export type SelectionMode = 'auto' | 'manual';

const ModeSelector = ({
  settingsKeyPrefix,
  selectionMode,
  onModeChange,
}: {
  settingsKeyPrefix: string;
  selectionMode: SelectionMode;
  onModeChange: (mode: SelectionMode) => void;
}) => {
  const { t } = useTranslation();

  return (
    <div className={styles.modeRow}>
      <span className={styles.modeLabel} id={`${settingsKeyPrefix}-mode-label`}>
        {t(`${settingsKeyPrefix}.modeLabel`)}
      </span>
      <div
        className={styles.segmentedControl}
        role="group"
        aria-labelledby={`${settingsKeyPrefix}-mode-label`}
        data-testid="ai-feature-mode-segment"
      >
        <button
          type="button"
          className={selectionMode === 'auto' ? styles.segmentActive : styles.segment}
          aria-pressed={selectionMode === 'auto'}
          data-testid="ai-feature-mode-auto"
          onClick={() => onModeChange('auto')}
        >
          {t(`${settingsKeyPrefix}.modeAuto`)}
        </button>
        <button
          type="button"
          className={selectionMode === 'manual' ? styles.segmentActive : styles.segment}
          aria-pressed={selectionMode === 'manual'}
          data-testid="ai-feature-mode-manual"
          onClick={() => onModeChange('manual')}
        >
          {t(`${settingsKeyPrefix}.modeManual`)}
        </button>
      </div>
    </div>
  );
};

export default ModeSelector;
