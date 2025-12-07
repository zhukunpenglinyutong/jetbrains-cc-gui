import { useCallback, useEffect, useRef, useState } from 'react';
import { Claude, OpenAI, Gemini } from '@lobehub/icons';
import { AVAILABLE_MODELS } from '../types';
import type { ModelInfo } from '../types';

interface ModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
  models?: ModelInfo[];  // 新增: 可选的动态模型列表
  currentProvider?: string;  // 当前提供商类型
}

/**
 * 模型图标组件 - 根据提供商类型显示不同图标
 */
const ModelIcon = ({ provider, size = 16 }: { provider?: string; size?: number }) => {
  switch (provider) {
    case 'codex':
      return <OpenAI.Avatar size={size} />;
    case 'gemini':
      return <Gemini.Color size={size} />;
    case 'claude':
    default:
      return <Claude.Color size={size} />;
  }
};

/**
 * ModelSelect - 模型选择器组件
 * 支持 Sonnet 4.5、Opus 4.5 等模型切换，以及 Codex 模型
 */
export const ModelSelect = ({ value, onChange, models = AVAILABLE_MODELS, currentProvider = 'claude' }: ModelSelectProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentModel = models.find(m => m.id === value) || models[0];

  /**
   * 切换下拉菜单
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  }, [isOpen]);

  /**
   * 选择模型
   */
  const handleSelect = useCallback((modelId: string) => {
    onChange(modelId);
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
        title={`当前模型: ${currentModel.label}`}
      >
        <ModelIcon provider={currentProvider} size={12} />
        <span>{currentModel.label}</span>
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
          {models.map((model) => (
            <div
              key={model.id}
              className={`selector-option ${model.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(model.id)}
            >
              <ModelIcon provider={currentProvider} size={16} />
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <span>{model.label}</span>
                {model.description && (
                  <span className="model-description">{model.description}</span>
                )}
              </div>
              {model.id === value && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModelSelect;
