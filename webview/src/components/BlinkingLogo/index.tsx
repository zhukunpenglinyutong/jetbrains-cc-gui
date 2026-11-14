import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import { AVAILABLE_PROVIDERS } from '../ChatInputBox/types';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';
import { useHiddenCliProviders } from '../../hooks/useCliProviderVisibility';

const ROOT_STYLE: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'center',
};

const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: '50%',
  transform: 'translateX(-50%)',
  marginTop: '8px',
  zIndex: 10000,
};
// The centered entry animation repeats the inline `translateX(-50%)` above; the
// default `.selector-dropdown` keyframes would drop it and jump the menu.
const DROPDOWN_CLASS = 'selector-dropdown provider-dropdown selector-dropdown--centered';

function getProviderOptionStyle(enabled: boolean): React.CSSProperties {
  return {
    opacity: enabled ? 1 : 0.5,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

interface BlinkingLogoProps {
  /** Runtime CLI provider id (claude / codex / opencode / …). Icon follows CLI, not model. */
  provider: string;
  onProviderChange?: (providerId: string) => void;
}

export const BlinkingLogo = ({ provider, onProviderChange }: BlinkingLogoProps) => {
  const { t } = useTranslation();
  const [displayProvider, setDisplayProvider] = useState(provider);
  const [animationState, setAnimationState] = useState<'idle' | 'closing' | 'opening'>('idle');

  // Dropdown state
  const [isOpen, setIsOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenProviders = useHiddenCliProviders();
  const visibleProviders = AVAILABLE_PROVIDERS.filter((p) => !hiddenProviders.has(p.id));

  // Render-time adjustment on provider change: start the close animation
  // (unless one is already running). Same transitions the old prop-change
  // effect produced, without an extra commit.
  const [prevProvider, setPrevProvider] = useState(provider);
  if (prevProvider !== provider) {
    setPrevProvider(provider);
    if (animationState === 'idle' || animationState === 'opening') {
      setAnimationState('closing');
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    if (animationState === 'closing') {
      timer = setTimeout(() => {
        setDisplayProvider(provider);
        setAnimationState('opening');
      }, 200);
    } else if (animationState === 'opening') {
      timer = setTimeout(() => {
        setAnimationState('idle');
      }, 200);
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [animationState, provider]);

  // Click outside handler
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleToggle = (e: React.MouseEvent) => {
    if (onProviderChange) {
       e.stopPropagation();
       setIsOpen(!isOpen);
    }
  };

  const showToastMessage = (message: string) => {
    setToastMessage(message);
    setShowToast(true);
    setTimeout(() => {
      setShowToast(false);
    }, 1500);
  };

  const handleSelect = (providerId: string) => {
    const selected = AVAILABLE_PROVIDERS.find(p => p.id === providerId);
    if (!selected) return;

    setIsOpen(false);
    if (!selected.enabled) {
      showToastMessage(t('settings.provider.featureComingSoon'));
      return;
    }
    onProviderChange?.(providerId);
  };

  const getProviderLabel = (providerId: string) => {
    return t(`providers.${providerId}.label`);
  };

  const logoStyle: React.CSSProperties = {
    cursor: onProviderChange ? 'pointer' : 'default',
  };

  return (
    <div style={ROOT_STYLE}>
      <div
        ref={containerRef}
        className={`${styles.container} ${styles[animationState]}`}
        onClick={handleToggle}
        style={logoStyle}
        role={onProviderChange ? 'button' : undefined}
        tabIndex={onProviderChange ? 0 : undefined}
        onKeyDown={(e) => {
          if (onProviderChange && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            handleToggle(e as unknown as React.MouseEvent);
          }
        }}
      >
        <ProviderModelIcon
          providerId={displayProvider}
          size={displayProvider === 'codex' ? 64 : 58}
          colored
        />
      </div>

      {isOpen && (
        <div
          ref={dropdownRef}
          className={DROPDOWN_CLASS}
          style={DROPDOWN_STYLE}
        >
          {visibleProviders.map((p) => (
            <div
              key={p.id}
              className={`selector-option ${p.id === provider ? 'selected' : ''} ${!p.enabled ? 'disabled' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                handleSelect(p.id);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  handleSelect(p.id);
                }
              }}
              style={getProviderOptionStyle(!!p.enabled)}
            >
              <ProviderModelIcon providerId={p.id} size={16} colored />
              <span>{getProviderLabel(p.id)}</span>
              <span className="provider-option-trailing">
                {p.id === provider && (
                  <span className="provider-active-dot" aria-hidden="true" />
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Toast notification */}
      {showToast && (
        <div className="selector-toast">
          {toastMessage}
        </div>
      )}
    </div>
  );
};
