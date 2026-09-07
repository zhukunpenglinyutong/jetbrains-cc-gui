import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DSH_PRESETS, getUserDshPresetOptions } from '../types';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';

const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
  overflowX: 'hidden',
};
const MODE_INFO_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
};
const MODE_TEXT_STYLE: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

interface DshPresetSelectProps {
  value: string;
  onChange: (preset: string) => void;
  embedded?: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose?: () => void;
}

export const DshPresetSelect = ({
  value,
  onChange,
  embedded = false,
  triggerRef,
  onClose,
}: DshPresetSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, maxHeight, maxWidth, recalculate } = useDropdownPosition({
    buttonRef: (embedded ? triggerRef : buttonRef) as React.RefObject<HTMLElement | null>,
    dropdownRef,
    minWidth: 260,
    maxWidth: 360,
    submenu: embedded,
  });

  const options = useMemo(
    () => [...DSH_PRESETS, ...getUserDshPresetOptions()],
    [],
  );
  const currentPreset = options.find((preset) => preset.id === value) || options[0];

  const getPresetText = (presetId: string, field: 'label' | 'description') => {
    const preset = options.find((item) => item.id === presetId);
    if (!preset) return '';
    if (field === 'label' && preset.label) return preset.label;
    const key = field === 'label' ? preset.labelKey : preset.descriptionKey;
    if (!key) return presetId;
    return t(key, { defaultValue: presetId });
  };

  const handleToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) recalculate();
  }, [isOpen, recalculate]);

  const handleSelect = useCallback((presetId: string) => {
    onChange(presetId);
    setIsOpen(false);
    onClose?.();
  }, [onChange, onClose]);

  useEffect(() => {
    if (embedded || !isOpen) return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current
        && !dropdownRef.current.contains(event.target as Node)
        && buttonRef.current
        && !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [embedded, isOpen]);

  useLayoutEffect(() => {
    if (embedded || isOpen) {
      recalculate();
    }
  }, [embedded, isOpen, recalculate]);

  const dropdownStyle: React.CSSProperties = embedded
    ? {
        minWidth: 0,
        maxWidth: maxWidth ?? 360,
        ...(maxHeight != null
          ? { maxHeight: `${Math.min(300, maxHeight)}px`, overflowY: 'auto' as const }
          : { overflowY: 'visible' as const }),
        ...positionedStyle,
      }
    : { ...DROPDOWN_STYLE, ...positionedStyle };

  const renderDropdown = () => (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          data-testid="dsh-preset-dropdown"
          style={dropdownStyle}
          onMouseEnter={(event) => event.stopPropagation()}
        >
          {options.map((preset) => (
            <div
              key={preset.id}
              data-testid={`dsh-preset-option-${preset.id || 'none'}`}
              className={`selector-option ${preset.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(preset.id)}
              title={getPresetText(preset.id, 'description')}
            >
              <span className={`codicon ${preset.id === '' ? 'codicon-circle-outline' : 'codicon-symbol-class'}`} />
              <div style={MODE_INFO_STYLE}>
                <span style={MODE_TEXT_STYLE}>{getPresetText(preset.id, 'label')}</span>
                <span className="mode-description" style={MODE_TEXT_STYLE}>
                  {getPresetText(preset.id, 'description')}
                </span>
              </div>
              {preset.id === value && <span className="codicon codicon-check check-mark" />}
            </div>
          ))}
        </div>
  );

  if (embedded) {
    return renderDropdown();
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        title={t('dshPresets.title', { defaultValue: getPresetText(currentPreset.id, 'description') })}
      >
        <span className="codicon codicon-robot" />
        <span className="selector-button-text">{getPresetText(currentPreset.id, 'label')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && renderDropdown()}
    </div>
  );
};

export default DshPresetSelect;
