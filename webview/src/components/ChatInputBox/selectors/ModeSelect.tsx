import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_MODES, type PermissionMode } from '../types';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_BASE_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
};
const MODE_INFO_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  overflow: 'hidden',
  minWidth: 0 // This is important for text truncation to work
};

const MODE_LABEL_STYLE: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
};

const MODE_DESCRIPTION_STYLE: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontSize: '12px',
  color: 'var(--text-secondary)'
};

function getModeOptionStyle(disabled: boolean): React.CSSProperties {
  return {
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

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
      // Codex supports default/acceptEdits/bypassPermissions; plan mode is not exposed yet.
      return AVAILABLE_MODES.filter((mode) => mode.id !== 'plan');
    }
    return AVAILABLE_MODES;
  }, [provider]);

  const currentMode = modeOptions.find(m => m.id === value) || modeOptions[0];
  const { positionedStyle, recalculate } = useDropdownPosition({
    buttonRef,
  });

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
    const next = !isOpen;
    setIsOpen(next);
    if (next) {
      recalculate();
    }
  }, [isOpen, recalculate]);

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
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className={`selector-button${value === 'bypassPermissions' ? ' mode-auto-active' : ''}`}
        onClick={handleToggle}
        title={getModeText(currentMode.id, 'tooltip') || `${t('chat.currentMode', { mode: getModeText(currentMode.id, 'label') })}`}
      >
        <span className={`codicon ${currentMode.icon}`} />
        <span className="selector-button-text">{getModeText(currentMode.id, 'label')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...DROPDOWN_BASE_STYLE, ...positionedStyle }}
        >
          {modeOptions.map((mode) => (
            <div
              key={mode.id}
              className={`selector-option ${mode.id === value ? 'selected' : ''} ${mode.disabled ? 'disabled' : ''}`}
              onClick={() => handleSelect(mode.id, mode.disabled)}
              title={getModeText(mode.id, 'tooltip')}
              style={getModeOptionStyle(!!mode.disabled)}
            >
              <span className={`codicon ${mode.icon}`} />
               <div style={MODE_INFO_STYLE}>
                 <span style={MODE_LABEL_STYLE}>{getModeText(mode.id, 'label')}</span>
                 <span style={MODE_DESCRIPTION_STYLE}>{getModeText(mode.id, 'description')}</span>
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
