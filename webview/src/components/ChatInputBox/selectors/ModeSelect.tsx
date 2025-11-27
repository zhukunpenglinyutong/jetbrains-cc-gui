import { useCallback, useState } from 'react';
import { AVAILABLE_MODES, type PermissionMode } from '../types';

interface ModeSelectProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}

/**
 * ModeSelect - 模式选择器组件
 * 支持默认模式、代理模式、规划模式切换
 * TODO: 下拉功能暂未实现
 */
export const ModeSelect = ({ value }: ModeSelectProps) => {
  const [showToast, setShowToast] = useState(false);

  const currentMode = AVAILABLE_MODES.find(m => m.id === value) || AVAILABLE_MODES[0];

  /**
   * 点击显示提示
   */
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowToast(true);
    setTimeout(() => setShowToast(false), 1500);
  }, []);

  // 注释掉的下拉菜单功能
  // const [isOpen, setIsOpen] = useState(false);
  // const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  // const buttonRef = useRef<HTMLButtonElement>(null);
  // const handleToggle = useCallback((e: React.MouseEvent) => { ... }, [isOpen]);
  // const handleSelect = useCallback((mode: PermissionMode) => { ... }, [onChange]);

  return (
    <>
      <button
        className="selector-button"
        onClick={handleClick}
        title={`当前模式: ${currentMode.label}`}
      >
        <span className={`codicon ${currentMode.icon}`} />
        <span>{currentMode.label}</span>
      </button>

      {showToast && (
        <div className="selector-toast">
          功能即将实现
        </div>
      )}
    </>
  );
};

export default ModeSelect;
