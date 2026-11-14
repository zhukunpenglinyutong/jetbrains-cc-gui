import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import { useSessionSupplier } from '../../../contexts/SessionSupplierContext';
import type { SupplierEntry } from '../../../hooks/useSessionSuppliers';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';

const DISABLED_OPTION_STYLE: React.CSSProperties = { cursor: 'default' };
const PROVIDER_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 };
const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };

interface RuntimeProviderSelectProps {
  currentProvider: string;
  embedded?: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose?: () => void;
  onProviderSwitched?: (providerName: string, appliesNextTurn: boolean) => void;
}

/**
 * Uses the chat's shared supplier controller, including its session binding fence.
 * This menu never changes the default supplier in global configuration.
 */
export const RuntimeProviderSelect = ({ currentProvider, embedded = false, triggerRef, onClose, onProviderSwitched }: RuntimeProviderSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const controller = useSessionSupplier();
  const session = controller?.provider === currentProvider ? controller : null;
  const visibleProviders = session?.suppliers ?? [];
  const loading = !session || session.pending;
  const selectionVersion = useRef(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, maxHeight: viewportMaxHeight, maxWidth, recalculate } = useDropdownPosition({
    buttonRef: (embedded ? triggerRef : buttonRef) as React.RefObject<HTMLElement | null>,
    dropdownRef,
    submenu: embedded,
    minWidth: embedded ? 260 : 200,
    maxWidth: 360,
  });

  const activeProvider = visibleProviders.find(provider => provider.id === session?.supplierId);

  const getProviderDisplayName = useCallback((provider: SupplierEntry) => {
    if (currentProvider === 'claude') {
      if (provider.id === SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS) {
        return t('settings.provider.localProviderName');
      }
      if (provider.id === SPECIAL_PROVIDER_IDS.CLI_LOGIN) {
        return t('settings.provider.cliLoginProviderName');
      }
      if (provider.id === SPECIAL_PROVIDER_IDS.DISABLED) {
        return t('settings.provider.disabled', { defaultValue: 'Disabled' });
      }
    }

    if (currentProvider === 'codex' && provider.id === SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN) {
      return t('settings.codexProvider.dialog.cliLoginProviderName');
    }

    return provider.name || provider.id;
  }, [t, currentProvider]);

  const refresh = session?.refresh;

  const handleToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (currentProvider !== 'claude' && currentProvider !== 'codex') {
      return;
    }
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      recalculate();
      refresh?.();
    }
  }, [currentProvider, isOpen, recalculate, refresh]);

  const handleSelect = useCallback(async (provider: SupplierEntry) => {
    if (!session || loading || !provider.available) return;
    if (provider.id === session.supplierId) {
      setIsOpen(false);
      onClose?.();
      return;
    }
    const version = ++selectionVersion.current;
    const switched = await session.selectSupplier(provider.id);
    // Closing the menu or changing conversations must not emit a late success toast.
    if (!switched || version !== selectionVersion.current) return;
    onProviderSwitched?.(getProviderDisplayName(provider), session.busy);
    setIsOpen(false);
    onClose?.();
  }, [getProviderDisplayName, onClose, onProviderSwitched, session, loading]);

  useEffect(() => () => { selectionVersion.current += 1; }, [currentProvider, session?.bindingToken]);

  useEffect(() => {
    if (!isOpen) return;

    let armed = false;
    const timer = setTimeout(() => { armed = true; }, 0);
    const handleClickOutside = (event: MouseEvent) => {
      if (!armed) return;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!embedded) return;
    refresh?.();
  }, [embedded, refresh]);

  useLayoutEffect(() => {
    if (!embedded) return;
    recalculate();
  }, [embedded, recalculate, visibleProviders.length, loading]);

  useLayoutEffect(() => {
    if (embedded || !isOpen) return;
    recalculate();
  }, [embedded, isOpen, recalculate, visibleProviders.length, loading]);

  if (currentProvider !== 'claude' && currentProvider !== 'codex') {
    return null;
  }

  const activeName = activeProvider ? getProviderDisplayName(activeProvider) : t('config.runtimeProvider.title');

  const dropdownMaxHeight = viewportMaxHeight ? `${Math.min(300, viewportMaxHeight)}px` : '300px';
  const dropdownStyle: React.CSSProperties = {
    minWidth: embedded ? 0 : 260,
    maxWidth: maxWidth ?? 360,
    maxHeight: dropdownMaxHeight,
    overflowY: 'auto',
    ...positionedStyle,
  };

  const renderProviderDropdown = () => (
    <div
      ref={dropdownRef}
      role="listbox"
      aria-label={t('config.runtimeProvider.title')}
      aria-busy={loading}
      className="selector-dropdown runtime-provider-dropdown"
      style={dropdownStyle}
      onMouseEnter={(event) => event.stopPropagation()}
    >
      {session?.error && (
        <div className="selector-option disabled" role="status">
          <span className="codicon codicon-warning" />
          <span>{t('sessionSupplier.unavailable', 'Supplier unavailable. Reopen this menu to retry or select another supplier.')}</span>
        </div>
      )}
      {loading && visibleProviders.length === 0 ? (
        <div className="selector-option disabled" style={DISABLED_OPTION_STYLE}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('config.runtimeProvider.loading')}</span>
        </div>
      ) : visibleProviders.length === 0 ? (
        <div className="selector-option disabled" style={DISABLED_OPTION_STYLE}>
          <span className="codicon codicon-info" />
          <span>{t('config.runtimeProvider.empty')}</span>
        </div>
      ) : (
        visibleProviders.map((provider) => {
          const selected = provider.id === session?.supplierId;
          const disabled = loading || !provider.available;
          return (
            <div
              key={provider.id}
              className={`selector-option ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
              role="option"
              aria-selected={selected}
              aria-disabled={disabled}
              tabIndex={disabled ? -1 : 0}
              onClick={() => { void handleSelect(provider); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  void handleSelect(provider);
                }
              }}
              title={getProviderDisplayName(provider)}
            >
              <span className="codicon codicon-key" />
              <div style={PROVIDER_INFO_STYLE}>
                <span className="runtime-provider-name">{getProviderDisplayName(provider)}</span>
              </div>
              {selected && <span className="codicon codicon-check check-mark" />}
            </div>
          );
        })
      )}
      {session?.deferred && (
        <div className="selector-option disabled" role="status">
          <span className="codicon codicon-clock" />
          <span>{t('sessionSupplier.nextTurn', 'Applies to the next turn')}</span>
        </div>
      )}
      {session?.missing && !loading && visibleProviders.length > 0 && !session.error && (
        <div className="selector-option disabled" role="status">
          <span className="codicon codicon-info" />
          <span>{t('sessionSupplier.choose', 'Select a supplier')}</span>
        </div>
      )}
    </div>
  );

  if (embedded) {
    return renderProviderDropdown();
  }

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        type="button"
        className="selector-button runtime-provider-button"
        onClick={handleToggle}
        aria-label={t('config.runtimeProvider.title')}
        title={`${t('config.runtimeProvider.title')}: ${activeName}`}
      >
        <span className="codicon codicon-vm-connect" />
        <span className="selector-button-text runtime-provider-text">{activeName}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && renderProviderDropdown()}
    </div>
  );
};

export default RuntimeProviderSelect;
