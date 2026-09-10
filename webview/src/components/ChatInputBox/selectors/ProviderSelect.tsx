import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_PROVIDERS } from '../types';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import AlertDialog from '../../AlertDialog';
import {
  fetchCodexSubscriptionQuota,
  subscribeCodexSubscriptionQuota,
  type CodexSubscriptionQuotaSnapshot,
} from '../../../utils/codexSubscriptionQuotaCapabilities';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { useBetaProviderNotice } from '../../../hooks/useBetaProviderNotice';
import { useHiddenCliProviders } from '../../../hooks/useCliProviderVisibility';
import { CodexQuotaSubmenu } from './CodexQuotaSubmenu';
import { ProviderOptionRow } from './ProviderOptionRow';
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
/** Gap (px) between the floating quota panel and the top of the provider dropdown. */
const SUBMENU_GAP_PX = 4;

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
  const [activeSubmenu, setActiveSubmenu] = useState<'none' | 'codexQuota'>('none');
  const [codexQuota, setCodexQuota] = useState<CodexSubscriptionQuotaSnapshot | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  // Distance (px) from the Codex row's bottom edge up to the floating quota panel,
  // so it hovers just above the entire dropdown instead of overlapping provider rows.
  const [submenuBottom, setSubmenuBottom] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, recalculate } = useDropdownPosition({ buttonRef, dropdownRef });
  const betaNotice = useBetaProviderNotice();

  const currentProvider = AVAILABLE_PROVIDERS.find(p => p.id === value) || AVAILABLE_PROVIDERS[0];
  // Hidden CLI providers stay usable when already active; they are only
  // removed from the switcher menu below.
  const hiddenProviders = useHiddenCliProviders();
  const visibleProviders = AVAILABLE_PROVIDERS.filter((p) => !hiddenProviders.has(p.id));

  // Helper function to get translated provider label
  const getProviderLabel = (providerId: string) => {
    return t(`providers.${providerId}.label`);
  };

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    setActiveSubmenu('none');
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

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

  const requestCodexQuota = useCallback(() => {
    setQuotaLoading(true);
    fetchCodexSubscriptionQuota();
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeCodexSubscriptionQuota((snapshot) => {
      setCodexQuota(snapshot);
      setQuotaLoading(false);
    });
    return unsubscribe;
  }, []);

  /**
   * Select provider
   */
  const handleSelect = useCallback((providerId: string) => {
    const provider = AVAILABLE_PROVIDERS.find(p => p.id === providerId);

    if (!provider) return;

    const proceed = () => {
      if (!provider.enabled) {
        showToastMessage(t('settings.provider.featureComingSoon'));
        return;
      }
      onChange?.(providerId);
    };

    // Close the menu immediately so the beta dialog is not hidden behind it.
    setIsOpen(false);
    // First click on a Beta provider shows an informational notice once.
    // Disabled providers skip the notice — they only show the coming-soon toast.
    betaNotice.requestSelect(!!provider.beta && provider.enabled, proceed);
  }, [onChange, showToastMessage, t, betaNotice]);

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

  useEffect(() => {
    if (!isOpen || activeSubmenu !== 'codexQuota') return;
    requestCodexQuota();
  }, [activeSubmenu, isOpen, requestCodexQuota]);

  useLayoutEffect(() => {
    if (isOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  const handleRowMouseEnter = useCallback((e: React.MouseEvent<HTMLDivElement>, providerId: string) => {
    if (providerId === 'codex') {
      // Float the quota panel just above the entire dropdown so it
      // never overlaps the provider rows, regardless of panel width.
      const rowRect = e.currentTarget.getBoundingClientRect();
      const dropdownRect = dropdownRef.current?.getBoundingClientRect();
      const bottomOffset = dropdownRect
        ? rowRect.bottom - dropdownRect.top + SUBMENU_GAP_PX
        : rowRect.height + SUBMENU_GAP_PX;
      setSubmenuBottom(Math.round(bottomOffset));
      setActiveSubmenu('codexQuota');
    } else {
      setActiveSubmenu('none');
    }
  }, []);

  const handleRowMouseLeave = useCallback((providerId: string) => {
    if (providerId === 'codex') {
      setActiveSubmenu('none');
    }
  }, []);

  return (
    <>
      <div style={RELATIVE_INLINE_BLOCK_STYLE}>
        <button
          ref={buttonRef}
          className={`selector-button${compact ? ' provider-compact' : ''}`}
          onClick={handleToggle}
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
            className="selector-dropdown provider-dropdown"
            style={{ ...DROPDOWN_STYLE, ...positionedStyle }}
          >
            {visibleProviders.map((provider) => (
              <ProviderOptionRow
                key={provider.id}
                provider={provider}
                isSelected={provider.id === value}
                label={getProviderLabel(provider.id)}
                trailingPanel={
                  activeSubmenu === 'codexQuota' ? (
                    <CodexQuotaSubmenu
                      quota={codexQuota}
                      loading={quotaLoading}
                      bottom={submenuBottom}
                      onHover={() => setActiveSubmenu('codexQuota')}
                    />
                  ) : undefined
                }
                onSelect={handleSelect}
                onRowMouseEnter={handleRowMouseEnter}
                onRowMouseLeave={handleRowMouseLeave}
              />
            ))}
            {onOpenCliSettings && (
              <ProviderCliFooter
                onOpenCliSettings={() => {
                  setIsOpen(false);
                  onOpenCliSettings();
                }}
              />
            )}
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

      <AlertDialog
        isOpen={betaNotice.isOpen}
        type="warning"
        title={t('providers.beta.title', { defaultValue: 'Beta Feature' })}
        message={t('providers.beta.message', {
          defaultValue:
            'This feature is still in Beta. If you encounter any bugs, please report them to the author promptly.',
        })}
        confirmText={t('common.gotIt', { defaultValue: 'Got it' })}
        onClose={betaNotice.close}
      />
    </>
  );
};

export default ProviderSelect;
