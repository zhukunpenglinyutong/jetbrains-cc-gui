import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_MODES, type PermissionMode } from '../types';

interface ModeSelectProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}

/**
 * ModeSelect - 模式选择器组件
 * 支持默认模式、代理模式、规划模式、自动模式切换
 */
export const ModeSelect = ({ value, onChange }: ModeSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentMode = AVAILABLE_MODES.find(m => m.id === value) || AVAILABLE_MODES[0];

  // Helper function to get translated mode text
  const getModeText = (modeId: PermissionMode, field: 'label' | 'tooltip' | 'description') => {
    return t(`modes.${modeId}.${field}`);
  };

  /**
   * 切换下拉菜单
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  }, [isOpen]);

  /**
   * 选择模式
   */
  const handleSelect = useCallback((mode: PermissionMode, disabled?: boolean) => {
    if (disabled) return; // 禁用的选项不能选择
    onChange(mode);
    setIsOpen(false);
  }, [onChange]);

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
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        title={getModeText(currentMode.id, 'tooltip') || `${t('chat.currentMode', { mode: getModeText(currentMode.id, 'label') })}`}
      >
        <span className={`codicon ${currentMode.icon}`} />
        <span>{getModeText(currentMode.id, 'label')}</span>
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
          {AVAILABLE_MODES.map((mode) => (
            <div
              key={mode.id}
              className={`selector-option ${mode.id === value ? 'selected' : ''} ${mode.disabled ? 'disabled' : ''}`}
              onClick={() => handleSelect(mode.id, mode.disabled)}
              title={getModeText(mode.id, 'tooltip')}
              style={{
                opacity: mode.disabled ? 0.5 : 1,
                cursor: mode.disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <span className={`codicon ${mode.icon}`} />
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <span>{getModeText(mode.id, 'label')}</span>
                <span className="mode-description">{getModeText(mode.id, 'description')}</span>
              </div>
              {mode.id === value && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModeSelect;
