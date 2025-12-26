import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ButtonAreaProps, ModelInfo, PermissionMode } from './types';
import { ConfigSelect, ModelSelect, ModeSelect } from './selectors';
import { CLAUDE_MODELS, CODEX_MODELS } from './types';

/**
 * ButtonArea - 底部工具栏组件
 * 包含模式选择、模型选择、附件按钮、发送/停止按钮
 */
export const ButtonArea = ({
  disabled = false,
  hasInputContent = false,
  isLoading = false,
  selectedModel = 'claude-sonnet-4-5',
  permissionMode = 'default',
  currentProvider = 'claude',
  onSubmit,
  onStop,
  onModeSelect,
  onModelSelect,
  onProviderSelect,
  alwaysThinkingEnabled = false,
  onToggleThinking,
}: ButtonAreaProps) => {
  const { t } = useTranslation();
  // const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * 应用模型名称映射
   * 将基础模型 ID 映射为实际的模型名称（如带容量后缀的版本）
   */
  const applyModelMapping = (model: ModelInfo, mapping: { haiku?: string; sonnet?: string; opus?: string }): ModelInfo => {
    const modelKeyMap: Record<string, keyof typeof mapping> = {
      'claude-sonnet-4-5': 'sonnet',
      'claude-opus-4-5-20251101': 'opus',
      'claude-haiku-4-5': 'haiku',
    };

    const key = modelKeyMap[model.id];
    if (key && mapping[key]) {
      const actualModel = String(mapping[key]).trim();
      if (actualModel.length > 0) {
        // 保持原始 id 作为唯一标识，只修改 label 为自定义名称
        // 这样即使多个模型有相同的 displayName，id 仍然是唯一的
        return { ...model, label: actualModel };
      }
    }
    return model;
  };

  // 根据当前提供商选择模型列表
  const availableModels = (() => {
    if (currentProvider === 'codex') {
      return CODEX_MODELS;
    }
    if (typeof window === 'undefined' || !window.localStorage) {
      return CLAUDE_MODELS;
    }
    try {
      const stored = window.localStorage.getItem('claude-model-mapping');
      if (!stored) {
        return CLAUDE_MODELS;
      }
      const mapping = JSON.parse(stored) as {
        main?: string;
        haiku?: string;
        sonnet?: string;
        opus?: string;
      };
      return CLAUDE_MODELS.map((m) => applyModelMapping(m, mapping));
    } catch {
      return CLAUDE_MODELS;
    }
  })();

  /**
   * 处理提交按钮点击
   */
  const handleSubmitClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSubmit?.();
  }, [onSubmit]);

  /**
   * 处理停止按钮点击
   */
  const handleStopClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStop?.();
  }, [onStop]);

  /**
   * 处理模式选择
   */
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    onModeSelect?.(mode);
  }, [onModeSelect]);

  /**
   * 处理模型选择
   */
  const handleModelSelect = useCallback((modelId: string) => {
    onModelSelect?.(modelId);
  }, [onModelSelect]);

  /**
   * 处理提供商选择
   */
  const handleProviderSelect = useCallback((providerId: string) => {
    onProviderSelect?.(providerId);
  }, [onProviderSelect]);

  return (
    <div className="button-area">
      {/* 左侧：选择器 */}
      <div className="button-area-left">
        <ConfigSelect 
          currentProvider={currentProvider}
          onProviderChange={handleProviderSelect}
          alwaysThinkingEnabled={alwaysThinkingEnabled}
          onToggleThinking={onToggleThinking}
        />
        <ModeSelect value={permissionMode} onChange={handleModeSelect} />
        <ModelSelect value={selectedModel} onChange={handleModelSelect} models={availableModels} currentProvider={currentProvider} />
      </div>

      {/* 右侧:工具按钮 */}
      <div className="button-area-right">
        <div className="button-divider" />

        {/* 发送/停止按钮 */}
        {isLoading ? (
          <button
            className="submit-button stop-button"
            onClick={handleStopClick}
            title={t('chat.stopGeneration')}
          >
            <span className="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button
            className="submit-button"
            onClick={handleSubmitClick}
            disabled={disabled || !hasInputContent}
            title={t('chat.sendMessageEnter')}
          >
            <span className="codicon codicon-send" />
          </button>
        )}
      </div>
    </div>
  );
};

export default ButtonArea;
