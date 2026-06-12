import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexFastMode } from '../types';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 0,
  marginBottom: '4px',
  zIndex: 10000,
};
const MODE_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1 };

interface CodexFastModeSelectProps {
  value: CodexFastMode;
  onChange: (mode: CodexFastMode) => void;
}

const CODEX_FAST_MODE_OPTIONS: Array<{
  id: CodexFastMode;
  label: string;
  description: string;
  icon: string;
}> = [
  {
    id: 'normal',
    label: 'Standard',
    description: 'Use the standard Codex service tier',
    icon: 'codicon-circle-filled',
  },
  {
    id: 'fast',
    label: 'Fast',
    description: 'Use Codex fast processing',
    icon: 'codicon-zap',
  },
];

export const CodexFastModeSelect = ({ value, onChange }: CodexFastModeSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentMode = CODEX_FAST_MODE_OPTIONS.find(mode => mode.id === value) || CODEX_FAST_MODE_OPTIONS[0];

  const getModeText = (mode: typeof CODEX_FAST_MODE_OPTIONS[number], field: 'label' | 'description') => {
    return t(`codexFastMode.${mode.id}.${field}`, { defaultValue: mode[field] });
  };

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  }, [isOpen]);

  const handleSelect = useCallback((mode: CodexFastMode) => {
    onChange(mode);
    setIsOpen(false);
  }, [onChange]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className={`selector-button${value === 'fast' ? ' codex-fast-active' : ''}`}
        onClick={handleToggle}
        title={t('codexFastMode.title', { defaultValue: 'Select Codex speed mode' })}
      >
        <span className={`codicon ${currentMode.icon}`} />
        <span className="selector-button-text">{getModeText(currentMode, 'label')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={DROPDOWN_STYLE}
        >
          {CODEX_FAST_MODE_OPTIONS.map((mode) => (
            <div
              key={mode.id}
              className={`selector-option ${mode.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(mode.id)}
              title={getModeText(mode, 'description')}
            >
              <span className={`codicon ${mode.icon}`} />
              <div style={MODE_INFO_STYLE}>
                <span>{getModeText(mode, 'label')}</span>
                <span className="mode-description">{getModeText(mode, 'description')}</span>
              </div>
              {mode.id === value && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CodexFastModeSelect;
