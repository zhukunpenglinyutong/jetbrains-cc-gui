import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './style.module.less';

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Custom listbox select — native <select> popups are unreliable in JCEF
 * (hit-testing breaks with overlays / disabled options / overflow).
 * Same pattern as DependencySection VersionSelect and BehaviorTab SoundSelect.
 */
const FeatureSelect = ({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  icon,
  testId,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  icon?: ReactNode;
  testId?: string;
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  return (
    <div className={styles.selectWrap} ref={containerRef} data-testid={testId}>
      {icon && (
        <span className={styles.iconWrap} aria-hidden="true">
          {icon}
        </span>
      )}
      <button
        type="button"
        className={`${styles.selectTrigger} ${open ? styles.open : ''} ${icon ? styles.withIcon : ''}`}
        onClick={() => {
          if (!disabled) {
            setOpen((prev) => !prev);
          }
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={styles.selectValue}>{selectedLabel}</span>
        <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
      </button>

      {open && (
        <div className={styles.dropdown} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`${styles.option} ${selected ? styles.selected : ''}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className={styles.optionLabel}>{option.label}</span>
                {selected && <span className="codicon codicon-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default FeatureSelect;
