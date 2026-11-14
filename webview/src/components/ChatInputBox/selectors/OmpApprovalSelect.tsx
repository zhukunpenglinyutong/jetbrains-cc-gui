import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OMP_APPROVAL_OPTIONS, type OmpApprovalMode } from '../types';
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

interface OmpApprovalSelectProps {
  value: OmpApprovalMode;
  onChange: (mode: OmpApprovalMode) => void;
  embedded?: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose?: () => void;
}

export const OmpApprovalSelect = ({
  value,
  onChange,
  embedded = false,
  triggerRef,
  onClose,
}: OmpApprovalSelectProps) => {
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

  const currentOption = OMP_APPROVAL_OPTIONS.find((option) => option.id === value) || OMP_APPROVAL_OPTIONS[0];

  const getOptionText = (option: typeof OMP_APPROVAL_OPTIONS[number], field: 'label' | 'description') =>
    t(field === 'label' ? option.labelKey : option.descriptionKey, { defaultValue: option[field] });

  const handleToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) recalculate();
  }, [isOpen, recalculate]);

  const handleSelect = useCallback((mode: OmpApprovalMode) => {
    onChange(mode);
    setIsOpen(false);
    onClose?.();
  }, [onChange, onClose]);

  useEffect(() => {
    if (embedded || !isOpen) return undefined;

    let armed = false;
    const timer = setTimeout(() => { armed = true; }, 0);
    const handleClickOutside = (event: MouseEvent) => {
      if (!armed) return;
      if (
        dropdownRef.current
        && !dropdownRef.current.contains(event.target as Node)
        && buttonRef.current
        && !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
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
      data-testid="omp-approval-dropdown"
      style={dropdownStyle}
      onMouseEnter={(event) => event.stopPropagation()}
    >
      {OMP_APPROVAL_OPTIONS.map((option) => (
        <div
          key={option.id}
          data-testid={`omp-approval-option-${option.id}`}
          className={`selector-option ${option.id === value ? 'selected' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => handleSelect(option.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleSelect(option.id);
            }
          }}
          title={getOptionText(option, 'description')}
        >
          <span className={`codicon ${option.icon}`} />
          <div style={MODE_INFO_STYLE}>
            <span style={MODE_TEXT_STYLE}>{getOptionText(option, 'label')}</span>
            <span className="mode-description" style={MODE_TEXT_STYLE}>
              {getOptionText(option, 'description')}
            </span>
          </div>
          {option.id === value && <span className="codicon codicon-check check-mark" />}
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
        title={t('ompApprovals.title', { defaultValue: getOptionText(currentOption, 'description') })}
      >
        <span className={`codicon ${currentOption.icon}`} />
        <span className="selector-button-text">{getOptionText(currentOption, 'label')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && renderDropdown()}
    </div>
  );
};

export default OmpApprovalSelect;
