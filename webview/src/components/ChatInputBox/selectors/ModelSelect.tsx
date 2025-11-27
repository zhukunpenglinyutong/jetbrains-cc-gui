import { useCallback, useState } from 'react';
import { AVAILABLE_MODELS } from '../types';

interface ModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
}

/**
 * ModelSelect - 模型选择器组件
 * 支持 Sonnet 4.5、Opus 4.5 等模型切换
 * TODO: 下拉功能暂未实现
 */
export const ModelSelect = ({ value }: ModelSelectProps) => {
  const [showToast, setShowToast] = useState(false);

  const currentModel = AVAILABLE_MODELS.find(m => m.id === value) || AVAILABLE_MODELS[0];

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
  // const handleSelect = useCallback((modelId: string) => { ... }, [onChange]);

  return (
    <>
      <button
        className="selector-button"
        onClick={handleClick}
        title={`当前模型: ${currentModel.label}`}
      >
        <span className="codicon codicon-hubot" />
        <span>{currentModel.label}</span>
      </button>

      {showToast && (
        <div className="selector-toast">
          功能即将实现
        </div>
      )}
    </>
  );
};

export default ModelSelect;
