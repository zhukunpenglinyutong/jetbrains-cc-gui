import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Claude, OpenAI, Gemini } from '@lobehub/icons';
import styles from './style.module.less';
import { AVAILABLE_PROVIDERS } from '../ChatInputBox/types';

interface BlinkingLogoProps {
  provider: string;
  onProviderChange?: (providerId: string) => void;
}

const ProviderIcon = ({ providerId, size = 16, colored = false }: { providerId: string; size?: number; colored?: boolean }) => {
  switch (providerId) {
    case 'claude':
      return colored ? <Claude.Color size={size} /> : <Claude.Avatar size={size} />;
    case 'codex':
      return <OpenAI.Avatar size={size} />;
    case 'gemini':
      return colored ? <Gemini.Color size={size} /> : <Gemini.Avatar size={size} />;
    default:
      return colored ? <Claude.Color size={size} /> : <Claude.Avatar size={size} />;
  }
};

export const BlinkingLogo = ({ provider, onProviderChange }: BlinkingLogoProps) => {
  const { t } = useTranslation();
  const [displayProvider, setDisplayProvider] = useState(provider);
  const [animationState, setAnimationState] = useState<'idle' | 'closing' | 'opening'>('idle');
  
  // Dropdown state
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (provider !== displayProvider) {
      if (animationState === 'idle') {
        setAnimationState('closing');
      } else if (animationState === 'opening') {
         // If we are opening and provider changes again, we should probably close again.
         setAnimationState('closing');
      }
      // If already closing, do nothing, let it finish closing.
    }
  }, [provider, displayProvider, animationState]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    
    if (animationState === 'closing') {
      timer = setTimeout(() => {
        setDisplayProvider(provider);
        setAnimationState('opening');
      }, 200); // Match CSS transition duration
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

  const handleSelect = (providerId: string) => {
    if (onProviderChange) {
      onProviderChange(providerId);
    }
    setIsOpen(false);
  };

  const getProviderLabel = (providerId: string) => {
    return t(`providers.${providerId}.label`);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
      <div 
        ref={containerRef}
        className={`${styles.container} ${styles[animationState]}`}
        onClick={handleToggle}
        style={{ cursor: onProviderChange ? 'pointer' : 'default' }}
      >
        {displayProvider === 'codex' ? (
          <OpenAI.Avatar size={64} />
        ) : (
          <Claude.Color size={58} />
        )}
      </div>
      
      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: '8px',
            zIndex: 10000,
          }}
        >
          {AVAILABLE_PROVIDERS.map((p) => (
            <div
              key={p.id}
              className={`selector-option ${p.id === provider ? 'selected' : ''} ${!p.enabled ? 'disabled' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (p.enabled) handleSelect(p.id);
              }}
              style={{
                opacity: p.enabled ? 1 : 0.5,
                cursor: p.enabled ? 'pointer' : 'not-allowed',
              }}
            >
              <ProviderIcon providerId={p.id} size={16} colored={true} />
              <span>{getProviderLabel(p.id)}</span>
              {p.id === provider && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
