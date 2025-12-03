import { useCallback, useEffect, useRef, useState } from 'react';
import { AVAILABLE_PROVIDERS } from '../types';

interface ProviderSelectProps {
  value: string;
  onChange?: (providerId: string) => void;
}

/**
 * ProviderSelect - AI 提供商选择器组件
 * 支持 Claude、Codex、Gemini 等提供商切换
 */
export const ProviderSelect = ({ value, onChange }: ProviderSelectProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentProvider = AVAILABLE_PROVIDERS.find(p => p.id === value) || AVAILABLE_PROVIDERS[0];

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
      showToastMessage('切换功能暂未实现，敬请期待');
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
          title={`当前提供商: ${currentProvider.label}`}
        >
          <span className={`codicon ${currentProvider.icon}`} />
          <span>{currentProvider.label}</span>
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
                <span className={`codicon ${provider.icon}`} />
                <span>{provider.label}</span>
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
