import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './style.module.less';

export interface PetSelectOption {
  value: string;
  label: string;
  detail: string;
  searchText: string;
}

export default function SearchablePetSelect({
  value,
  options,
  ariaLabel,
  searchPlaceholder,
  emptyLabel,
  onChange,
}: {
  value: string;
  options: PetSelectOption[];
  ariaLabel: string;
  searchPlaceholder: string;
  emptyLabel: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = useMemo(() => normalizedQuery
    ? options.filter((option) => option.searchText.includes(normalizedQuery))
    : options, [normalizedQuery, options]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    inputRef.current?.focus();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  const selectOption = useCallback((option: PetSelectOption) => {
    onChange(option.value);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onChange]);

  return (
    <div className={styles.petSelect} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.petSelectTrigger}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls="codex-pet-select-options"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? value}</span>
        <span className="codicon codicon-chevron-down" aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.petSelectPopover}>
          <label className={styles.petSelectSearch}>
            <span className="codicon codicon-search" aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-activedescendant={filteredOptions[activeIndex]
                ? `codex-pet-option-${activeIndex}`
                : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                  window.requestAnimationFrame(() => triggerRef.current?.focus());
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  if (filteredOptions.length > 0) {
                    setActiveIndex((current) => Math.min(current + 1, filteredOptions.length - 1));
                  }
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((current) => Math.max(0, current - 1));
                } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && filteredOptions[activeIndex]) {
                  event.preventDefault();
                  selectOption(filteredOptions[activeIndex]);
                }
              }}
            />
          </label>
          <div id="codex-pet-select-options" className={styles.petSelectOptions} role="listbox">
            {filteredOptions.map((option, index) => (
              <button
                type="button"
                id={`codex-pet-option-${index}`}
                ref={(element) => { optionRefs.current[index] = element; }}
                role="option"
                aria-selected={option.value === value}
                key={option.value}
                className={index === activeIndex ? styles.petSelectOptionActive : styles.petSelectOption}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
              >
                <span>{option.label}</span>
                <small>{option.detail}</small>
              </button>
            ))}
            {filteredOptions.length === 0 && <div className={styles.petSelectEmpty}>{emptyLabel}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
