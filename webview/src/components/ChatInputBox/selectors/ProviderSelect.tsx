import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Claude, OpenAI, Gemini } from '@lobehub/icons';
import { AVAILABLE_PROVIDERS } from '../types';

interface ProviderSelectProps {
  value: string;
  onChange?: (providerId: string) => void;
}

/**
 * 提供商图标映射
 */
const ProviderIcon = ({ providerId, size = 16 }: { providerId: string; size?: number }) => {
  switch (providerId) {
    case 'claude':
      return <Claude.Avatar size={size} />;
    case 'codex':
      return <OpenAI.Avatar size={size} />;
    case 'gemini':
      return <Gemini.Avatar size={size} />;
    default:
      return <Claude.Avatar size={size} />;
  }
};

/**
 * ProviderSelect - AI 提供商选择器组件
 * 支持 Claude、Codex、Gemini 等提供商切换
 */
export const ProviderSelect = ({ value, onChange }: ProviderSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentProvider = AVAILABLE_PROVIDERS.find(p => p.id === value) || AVAILABLE_PROVIDERS[0];

  // Helper function to get translated provider label
  const getProviderLabel = (providerId: string) => {
    return t(`providers.${providerId}.label`);
  };

  /**
   * 切换下拉菜单
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  }, [isOpen]);

  /**
   * 显示提示信息
   */
  const showToastMessage = useCallback((message: string) => {
    setToastMessage(message);
    setShowToast(true);
    setTimeout(() => {
      setShowToast(false);
    }, 1500);
  }, []);

  /**
   * 选择提供商
   */
  const handleSelect = useCallback((providerId: string) => {
    const provider = AVAILABLE_PROVIDERS.find(p => p.id === providerId);

    if (!provider) return;

    if (!provider.enabled) {
      // 如果提供商不可用，显示提示
      showToastMessage(t('settings.provider.featureComingSoon'));
      setIsOpen(false);
      return;
    }

    // 提供商可用，执行切换
    onChange?.(providerId);
    setIsOpen(false);
  }, [onChange, showToastMessage]);

  /**
   * 点击外部关闭
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

    // 延迟添加事件监听，避免立即触发
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <button
          ref={buttonRef}
          className="selector-button"
          onClick={handleToggle}
          title={`${t('config.switchProvider')}: ${getProviderLabel(currentProvider.id)}`}
        >
          <ProviderIcon providerId={currentProvider.id} size={12} />
          <span>{getProviderLabel(currentProvider.id)}</span>
          <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={{ fontSize: '10px', marginLeft: '2px' }} />
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
            }}
          >
            {AVAILABLE_PROVIDERS.map((provider) => (
              <div
                key={provider.id}
                className={`selector-option ${provider.id === value ? 'selected' : ''} ${!provider.enabled ? 'disabled' : ''}`}
                onClick={() => handleSelect(provider.id)}
                style={{
                  opacity: provider.enabled ? 1 : 0.5,
                  cursor: provider.enabled ? 'pointer' : 'not-allowed',
                }}
              >
                <ProviderIcon providerId={provider.id} size={16} />
                <span>{getProviderLabel(provider.id)}</span>
                {provider.id === value && (
                  <span className="codicon codicon-check check-mark" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 提示信息 */}
      {showToast && (
        <div className="selector-toast">
          {toastMessage}
        </div>
      )}
    </>
  );
};

export default ProviderSelect;
