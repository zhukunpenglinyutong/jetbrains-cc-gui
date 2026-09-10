import { useState, useEffect, useRef } from 'react';
import styles from './style.module.less';

interface VersionSelectProps {
  value: string;
  options: string[];
  disabled: boolean;
  label: string;
  valueLabel: string;
  onChange: (version: string) => void;
}

const VersionSelect = ({
  value,
  options,
  disabled,
  label,
  valueLabel,
  onChange,
}: VersionSelectProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const displayValue = value ? `v${value}` : '-';

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
    <div className={styles.versionSelect} ref={containerRef}>
      <button
        type="button"
        className={`${styles.versionSelectTrigger} ${open ? styles.open : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={valueLabel}
      >
        <span className={styles.versionSelectValue}>{displayValue}</span>
        <span className={`codicon codicon-chevron-down ${styles.versionSelectIcon}`} />
      </button>

      {open && (
        <div className={styles.versionDropdown} role="listbox" aria-label={label}>
          {options.map((version) => {
            const selected = version === value;

            return (
              <button
                key={version}
                type="button"
                role="option"
                aria-selected={selected}
                className={`${styles.versionOption} ${selected ? styles.selected : ''}`}
                onClick={() => {
                  onChange(version);
                  setOpen(false);
                }}
              >
                <span>{`v${version}`}</span>
                {selected && <span className="codicon codicon-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default VersionSelect;
