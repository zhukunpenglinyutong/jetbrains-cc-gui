import styles from './style.module.less';

export interface ToggleSettingSectionProps {
  icon: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  enabledLabel: string;
  disabledLabel: string;
  hint: string;
}

/** Shared layout for the repeated boolean toggle setting sections. */
export function ToggleSettingSection({
  icon,
  label,
  checked,
  onChange,
  enabledLabel,
  disabledLabel,
  hint,
}: ToggleSettingSectionProps) {
  return (
    <div className={styles.streamingSection}>
      <div className={styles.fieldHeader}>
        <span className={`codicon ${icon}`} />
        <span className={styles.fieldLabel}>{label}</span>
      </div>
      <label className={styles.toggleWrapper}>
        <input
          type="checkbox"
          className={styles.toggleInput}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={styles.toggleSlider} />
        <span className={styles.toggleLabel}>
          {checked ? enabledLabel : disabledLabel}
        </span>
      </label>
      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{hint}</span>
      </small>
    </div>
  );
}
