import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_MODES, type PermissionMode } from '../types';

interface ModeSelectProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  provider?: string;
}

/**
 * ModeSelect - Mode selector component
 * Supports switching between default, agent, plan, and auto modes
 */
export const ModeSelect = ({ value, onChange, provider }: ModeSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const modeOptions = useMemo(() => {
    if (provider === 'codex') {
      // Codex only has three modes: default, agent, auto (filter out plan mode)
      return AVAILABLE_MODES.filter((mode) => mode.id !== 'plan').map((mode) => {
        if (mode.id === 'default' || mode.id === 'acceptEdits') {
          return { ...mode, disabled: true };
        }
        return mode;
      });
    }
    return AVAILABLE_MODES;
  }, [provider]);

  const currentMode = modeOptions.find(m => m.id === value) || modeOptions[0];

  // Helper function to get translated mode text
  const getModeText = (modeId: PermissionMode, field: 'label' | 'tooltip' | 'description') => {
    if (provider === 'codex') {
      const codexKey = `codexModes.${modeId}.${field}`;
      const fallbackKey = `modes.${modeId}.${field}`;
      return t(codexKey, { defaultValue: t(fallbackKey) });
    }

    return t(`modes.${modeId}.${field}`);
  };

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  }, [isOpen]);

  /**
   * Select mode
   */
  const handleSelect = useCallback((mode: PermissionMode, disabled?: boolean) => {
    if (disabled) return; // Disabled options cannot be selected
    onChange(mode);
    setIsOpen(false);
  }, [onChange]);

  /**
   * Close on outside click
   */
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

    // Delay adding event listener to prevent immediate trigger
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        title={getModeText(currentMode.id, 'tooltip') || `${t('chat.currentMode', { mode: getModeText(currentMode.id, 'label') })}`}
      >
        <span className={`codicon ${currentMode.icon}`} />
        <span className="selector-button-text">{getModeText(currentMode.id, 'label')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={{ fontSize: '10px', marginLeft: '2px' }} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: '4px',
            zIndex: 10000,
          }}
        >
          {modeOptions.map((mode) => (
            <div
              key={mode.id}
              className={`selector-option ${mode.id === value ? 'selected' : ''} ${mode.disabled ? 'disabled' : ''}`}
              onClick={() => handleSelect(mode.id, mode.disabled)}
              title={getModeText(mode.id, 'tooltip')}
              style={{
                opacity: mode.disabled ? 0.5 : 1,
                cursor: mode.disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <span className={`codicon ${mode.icon}`} />
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <span>{getModeText(mode.id, 'label')}</span>
                <span className="mode-description">{getModeText(mode.id, 'description')}</span>
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

export default ModeSelect;
