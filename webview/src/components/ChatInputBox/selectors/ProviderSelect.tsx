import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_PROVIDERS } from '../types';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { useHiddenCliProviders } from '../../../hooks/useCliProviderVisibility';
import { CodexQuotaSubmenu } from './CodexQuotaSubmenu';
import { GeminiQuotaSubmenu } from './GeminiQuotaSubmenu';
import { hasProviderQuota, ProviderOptionRow, type QuotaProvider } from './ProviderOptionRow';
import { ProviderCliFooter } from './ProviderCliFooter';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
};
const TOAST_STYLE: React.CSSProperties = { zIndex: 20000 };
const QUOTA_SWITCH_DELAY_MS = 180;

interface ProviderSelectProps {
  value: string;
  onChange?: (providerId: string) => void;
  /** When true, shows only the provider icon without text or chevron */
  compact?: boolean;
  /** Open Settings → Providers → CLI management from the dropdown footer */
  onOpenCliSettings?: () => void;
}

/**
 * ProviderSelect - AI provider selector component
 * Supports switching between Claude, Codex, Gemini, and other providers
 * compact mode: icon-only button for toolbar use
 */
export const ProviderSelect = ({ value, onChange, compact = false, onOpenCliSettings }: ProviderSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [activeQuota, setActiveQuota] = useState<QuotaProvider | null>(null);
  const menuId = useId();
  const quotaId = `${menuId}-quota`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openingFocusRef = useRef<'selected' | 'first' | 'last' | null>(null);
  const pendingQuotaSwitch = useRef<number | undefined>(undefined);
  const quotaFocusRef = useRef<QuotaProvider | null>(null);
  const { positionedStyle, maxHeight, recalculate } = useDropdownPosition({ buttonRef, dropdownRef });

  const currentProvider = AVAILABLE_PROVIDERS.find(p => p.id === value) || AVAILABLE_PROVIDERS[0];
  // Hidden CLI providers stay usable when already active; they are only
  // removed from the switcher menu below.
  const hiddenProviders = useHiddenCliProviders();
  const visibleProviders = AVAILABLE_PROVIDERS.filter((p) => !hiddenProviders.has(p.id));

  // Helper function to get translated provider label
  const getProviderLabel = (providerId: string) => {
    return t(`providers.${providerId}.label`);
  };

  const cancelQuotaSwitch = useCallback(() => {
    window.clearTimeout(pendingQuotaSwitch.current);
    pendingQuotaSwitch.current = undefined;
  }, []);

  const closeMenu = useCallback(() => {
    cancelQuotaSwitch();
    quotaFocusRef.current = null;
    setIsOpen(false);
    setActiveQuota(null);
  }, [cancelQuotaSwitch]);

  useEffect(() => cancelQuotaSwitch, [cancelQuotaSwitch]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (isOpen) {
      closeMenu();
    } else {
      openingFocusRef.current = e.detail === 0 ? 'selected' : null;
      setIsOpen(true);
    }
  }, [isOpen, closeMenu]);

  const focusMenuItem = useCallback((position: 'selected' | 'first' | 'last') => {
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    if (!items?.length) return;
    const selected = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    const target = position === 'selected' ? selected ?? items[0]
      : position === 'last' ? items[items.length - 1] : items[0];
    target.focus();
  }, []);

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const position = event.key === 'ArrowDown' ? 'first' : 'last';
      if (isOpen) {
        focusMenuItem(position);
      } else {
        openingFocusRef.current = position;
        setIsOpen(true);
      }
    } else if (event.key === 'Tab' && isOpen) {
      // Pointer opening leaves focus here; remove the footer before native Tab navigation.
      closeMenu();
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    }
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      buttonRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      // Exit from the trigger's place in the toolbar instead of the removed row.
      closeMenu();
      buttonRef.current?.focus();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest('.provider-quota-panel')) {
      if (event.key === 'ArrowLeft') {
        dropdownRef.current?.querySelector<HTMLElement>(`[data-provider-id="${activeQuota}"]`)?.focus();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const providerId = target.dataset.providerId ?? '';
    if (event.key === 'ArrowRight' && hasProviderQuota(providerId)) {
      cancelQuotaSwitch();
      if (activeQuota === providerId) {
        dropdownRef.current?.querySelector<HTMLElement>('.provider-quota-panel')?.focus();
      } else {
        quotaFocusRef.current = providerId;
        setActiveQuota(providerId);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(dropdownRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitemradio"], .provider-cli-footer-btn',
    ) ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  /**
   * Show toast message
   */
  const showToastMessage = useCallback((message: string) => {
    setToastMessage(message);
    setShowToast(true);
    setTimeout(() => {
      setShowToast(false);
    }, 1500);
  }, []);

  /**
   * Select provider
   */
  const handleSelect = useCallback((providerId: string) => {
    const provider = AVAILABLE_PROVIDERS.find(p => p.id === providerId);

    if (!provider) return;

    // Close the menu and return focus to the trigger before applying the switch.
    closeMenu();
    buttonRef.current?.focus();
    if (!provider.enabled) {
      showToastMessage(t('settings.provider.featureComingSoon'));
      return;
    }
    onChange?.(providerId);
  }, [onChange, showToastMessage, t, closeMenu]);

  /**
   * Close on outside click
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        !dropdownRef.current?.contains(e.target as Node)
        && !buttonRef.current?.contains(e.target as Node)
      ) {
        closeMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, closeMenu]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    recalculate();
    if (openingFocusRef.current) {
      focusMenuItem(openingFocusRef.current);
      openingFocusRef.current = null;
    }
  }, [isOpen, recalculate, focusMenuItem]);

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('resize', recalculate);
    return () => window.removeEventListener('resize', recalculate);
  }, [isOpen, recalculate]);

  useLayoutEffect(() => {
    if (activeQuota && quotaFocusRef.current === activeQuota) {
      quotaFocusRef.current = null;
      dropdownRef.current?.querySelector<HTMLElement>('.provider-quota-panel')?.focus();
    }
  }, [activeQuota]);

  const handleActivate = useCallback((providerId: string) => {
    cancelQuotaSwitch();
    setActiveQuota(hasProviderQuota(providerId) ? providerId : null);
  }, [cancelQuotaSwitch]);

  const quotaHasFocus = () => dropdownRef.current?.contains(document.activeElement)
    && document.activeElement?.closest('.provider-quota-panel');

  const handleQuotaHover = (providerId: QuotaProvider | null) => {
    cancelQuotaSwitch();
    if (!providerId || providerId === activeQuota) return;
    // Pointer movement must not remove a panel while someone is scrolling it with the keyboard.
    if (quotaHasFocus()) return;
    if (!activeQuota) {
      setActiveQuota(providerId);
    } else {
      // A stacked panel can be reached only by crossing other menu rows.
      pendingQuotaSwitch.current = window.setTimeout(() => setActiveQuota(providerId), QUOTA_SWITCH_DELAY_MS);
    }
  };

  return (
    <>
      <div
        style={RELATIVE_INLINE_BLOCK_STYLE}
        onBlur={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closeMenu();
        }}
      >
        <button
          type="button"
          ref={buttonRef}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-controls={isOpen ? menuId : undefined}
          className={`selector-button${compact ? ' provider-compact' : ''}`}
          onClick={handleToggle}
          onKeyDown={handleTriggerKeyDown}
          title={`${t('config.switchProvider')}: ${getProviderLabel(currentProvider.id)}`}
        >
          <ProviderModelIcon providerId={currentProvider.id} size={compact ? 16 : 12} colored={compact} />
          {!compact && (
            <>
              <span>{getProviderLabel(currentProvider.id)}</span>
              <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
            </>
          )}
        </button>

        {isOpen && (
          <div
            ref={dropdownRef}
            className="selector-dropdown provider-dropdown provider-dropdown--scrollable"
            style={{ ...DROPDOWN_STYLE, ...positionedStyle, maxHeight }}
            onKeyDown={handleMenuKeyDown}
            onMouseLeave={() => {
              cancelQuotaSwitch();
              const focused = document.activeElement as HTMLElement | null;
              if (focused?.dataset.providerId !== activeQuota && !quotaHasFocus()) {
                setActiveQuota(null);
              }
            }}
          >
            {activeQuota === 'codex' && (
              <CodexQuotaSubmenu id={quotaId} anchorRef={dropdownRef} />
            )}
            {activeQuota === 'gemini' && (
              <GeminiQuotaSubmenu id={quotaId} anchorRef={dropdownRef} />
            )}
            <div className="provider-option-list">
              <div ref={menuRef} id={menuId} role="menu" aria-label={t('config.switchProvider')}>
                {visibleProviders.map((provider) => (
                  <ProviderOptionRow
                    key={provider.id}
                    provider={provider}
                    isSelected={provider.id === value}
                    label={getProviderLabel(provider.id)}
                    onSelect={handleSelect}
                    onActivate={handleActivate}
                    onQuotaHover={handleQuotaHover}
                    quotaId={activeQuota === provider.id ? quotaId : undefined}
                  />
                ))}
              </div>
              {onOpenCliSettings && (
                <div onFocus={() => handleActivate('')}>
                  <ProviderCliFooter
                    onOpenCliSettings={() => {
                      closeMenu();
                      onOpenCliSettings();
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Toast message */}
      {showToast && createPortal(
        <div className="selector-toast" style={TOAST_STYLE}>
          {toastMessage}
        </div>,
        document.body
      )}
    </>
  );
};

export default ProviderSelect;
