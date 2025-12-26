import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Switch } from 'antd';
import { Claude, OpenAI, Gemini } from '@lobehub/icons';
import { AVAILABLE_PROVIDERS } from '../types';

interface ConfigSelectProps {
  currentProvider: string;
  onProviderChange: (providerId: string) => void;
  alwaysThinkingEnabled?: boolean;
  onToggleThinking?: (enabled: boolean) => void;
}

/**
 * Provider Icon Component
 */
const ProviderIcon = ({ providerId, size = 16 }: { providerId: string; size?: number }) => {
  switch (providerId) {
    case 'claude':
      return <Claude size={size} />;
    case 'codex':
      return <OpenAI.Avatar size={size} />;
    case 'gemini':
      return <Gemini.Avatar size={size} />;
    default:
      return <Claude size={size} />;
  }
};

/**
 * ConfigSelect - Combined Configuration Selector
 * Contains CLI Tool Selection and Thinking Switch
 */
export const ConfigSelect = ({ 
  currentProvider: providerId, 
  onProviderChange,
  alwaysThinkingEnabled,
  onToggleThinking
}: ConfigSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<'none' | 'provider'>('none');
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentProviderInfo = AVAILABLE_PROVIDERS.find(p => p.id === providerId) || AVAILABLE_PROVIDERS[0];

  const showToastMessage = useCallback((message: string) => {
    setToastMessage(message);
    setShowToast(true);
    setTimeout(() => {
      setShowToast(false);
    }, 1500);
  }, []);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
    if (!isOpen) {
      setActiveSubmenu('none');
    }
  }, [isOpen]);

  const handleProviderSelect = useCallback((pId: string) => {
    const provider = AVAILABLE_PROVIDERS.find(p => p.id === pId);
    if (!provider) return;

    if (!provider.enabled) {
      showToastMessage(t('settings.provider.featureComingSoon'));
      return;
    }

    onProviderChange(pId);
    setIsOpen(false);
    setActiveSubmenu('none');
  }, [onProviderChange, showToastMessage, t]);

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
        setActiveSubmenu('none');
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const renderProviderSubmenu = () => (
    <div
      className="selector-dropdown"
      style={{
        position: 'absolute',
        left: '100%',
        bottom: 0,
        marginLeft: '-30px',
        zIndex: 10001,
        minWidth: '180px'
      }}
    >
      {AVAILABLE_PROVIDERS.map((provider) => (
        <div
          key={provider.id}
          className={`selector-option ${provider.id === providerId ? 'selected' : ''} ${!provider.enabled ? 'disabled' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            handleProviderSelect(provider.id);
          }}
        >
          <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ProviderIcon providerId={provider.id} size={14} />
          </div>
          <span>{provider.label}</span>
          {provider.id === providerId && <span className="codicon codicon-check check-mark" />}
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        style={{ marginLeft: '5px', marginRight: '-2px' }}
        title={t('settings.configure', 'Configure')}
      >
        <span className="codicon codicon-settings" />
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
            minWidth: '200px'
          }}
        >
          {/* CLI Tool Item */}
          <div 
            className="selector-option" 
            onMouseEnter={() => setActiveSubmenu('provider')}
            onMouseLeave={() => setActiveSubmenu('none')}
            style={{ position: 'relative' }}
          >
            <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ProviderIcon providerId={currentProviderInfo.id} size={14} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span>{currentProviderInfo.label}</span>
            </div>
            <div 
              style={{ 
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                alignSelf: 'stretch',
                paddingLeft: '12px',
                cursor: 'pointer'
              }}
            >
              <span className="codicon codicon-chevron-right" style={{ fontSize: '12px' }} />
            </div>
            
            {activeSubmenu === 'provider' && renderProviderSubmenu()}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--dropdown-border)', margin: '4px 0', opacity: 0.5 }} />

          {/* Provider Item (Disabled) */}
          <div
            className="selector-option disabled"
            style={{ position: 'relative', opacity: 0.5, cursor: 'not-allowed' }}
            onClick={(e) => {
              e.stopPropagation();
              showToastMessage(t('settings.provider.featureComingSoon'));
            }}
          >
            <span className="codicon codicon-vm-connect" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span>供应商</span>
            </div>
            <span className="codicon codicon-chevron-right" style={{ marginLeft: 'auto', fontSize: '12px' }} />
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--dropdown-border)', margin: '4px 0', opacity: 0.5 }} />

          {/* MCP Item (Disabled) */}
          <div
            className="selector-option disabled"
            style={{ position: 'relative', opacity: 0.5, cursor: 'not-allowed' }}
            onClick={(e) => {
              e.stopPropagation();
              showToastMessage(t('settings.provider.featureComingSoon'));
            }}
          >
            <span className="codicon codicon-server" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span>MCP</span>
            </div>
            <span className="codicon codicon-chevron-right" style={{ marginLeft: 'auto', fontSize: '12px' }} />
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--dropdown-border)', margin: '4px 0', opacity: 0.5 }} />

          {/* Agent Item (Disabled) */}
          <div
            className="selector-option disabled"
            style={{ position: 'relative', opacity: 0.5, cursor: 'not-allowed' }}
            onClick={(e) => {
              e.stopPropagation();
              showToastMessage(t('settings.provider.featureComingSoon'));
            }}
          >
            <span className="codicon codicon-robot" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span>Agent</span>
            </div>
            <span className="codicon codicon-chevron-right" style={{ marginLeft: 'auto', fontSize: '12px' }} />
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--dropdown-border)', margin: '4px 0', opacity: 0.5 }} />

          {/* Thinking Switch Item */}
          <div
            className="selector-option"
            onClick={(e) => {
              e.stopPropagation();
              onToggleThinking?.(!alwaysThinkingEnabled);
            }}
            onMouseEnter={() => setActiveSubmenu('none')}
            style={{ justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="codicon codicon-lightbulb" />
              <span>{t('common.thinking')}</span>
            </div>
            <Switch
              size="small"
              checked={alwaysThinkingEnabled ?? false}
              onClick={(checked, e) => {
                 e.stopPropagation();
                 onToggleThinking?.(checked);
              }}
            />
          </div>
        </div>
      )}

      {showToast && createPortal(
        <div className="selector-toast" style={{ zIndex: 20000 }}>
          {toastMessage}
        </div>,
        document.body
      )}
    </div>
  );
};
