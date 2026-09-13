import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import { AVAILABLE_PROVIDERS } from '../ChatInputBox/types';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';
import AlertDialog from '../AlertDialog';
import { useBetaProviderNotice } from '../../hooks/useBetaProviderNotice';
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
  const betaNotice = useBetaProviderNotice();
  const hiddenProviders = useHiddenCliProviders();
  const visibleProviders = AVAILABLE_PROVIDERS.filter((p) => !hiddenProviders.has(p.id));

  useEffect(() => {
    if (provider !== displayProvider) {
      if (animationState === 'idle') {
        setAnimationState('closing');
      } else if (animationState === 'opening') {
         setAnimationState('closing');
      }
    }
  }, [provider, displayProvider, animationState]);

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

    const proceed = () => {
      if (!selected.enabled) {
        showToastMessage(t('settings.provider.featureComingSoon'));
        return;
      }
      onProviderChange?.(providerId);
    };

    // Close the menu immediately so the beta dialog is not hidden behind it.
    setIsOpen(false);
    // First click on a Beta provider shows an informational notice once.
    // Disabled providers skip the notice — they only show the coming-soon toast.
    betaNotice.requestSelect(!!selected.beta && selected.enabled, proceed);
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
          className="selector-dropdown provider-dropdown"
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
              style={getProviderOptionStyle(!!p.enabled)}
            >
              <ProviderModelIcon providerId={p.id} size={16} colored />
              <span>{getProviderLabel(p.id)}</span>
              <span className="provider-option-trailing">
                {p.id === provider && (
                  <span className="provider-active-dot" aria-hidden="true" />
                )}
                {p.beta && (
                  <span className="provider-beta-badge">
                    {t('providers.beta.badge', { defaultValue: 'Beta' })}
                  </span>
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
    </div>
  );
};
