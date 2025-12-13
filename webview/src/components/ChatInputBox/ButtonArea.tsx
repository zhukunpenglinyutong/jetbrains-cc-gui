import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
// TODO: 临时隐藏模式选择器,后续恢复
// import type { ButtonAreaProps, PermissionMode } from './types';
import type { ButtonAreaProps } from './types';
// import { ModeSelect, ModelSelect } from './selectors';
import { ModelSelect, ProviderSelect } from './selectors';
// import { TokenIndicator } from './TokenIndicator';
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
  // TODO: 临时隐藏模式选择器,后续恢复
  // permissionMode = 'default',
  currentProvider = 'claude',
  remoteModels,
  onSubmit,
  onStop,
  // TODO: 临时隐藏模式选择器,后续恢复
  // onModeSelect,
  onModelSelect,
  onProviderSelect,
}: ButtonAreaProps) => {
  const { t } = useTranslation();
  // const fileInputRef = useRef<HTMLInputElement>(null);

  // 根据当前提供商选择模型列表
  const availableModels = useMemo(() => {
    if (currentProvider === 'codex') {
      return CODEX_MODELS;
    }

    // 如果有远程模型列表，优先使用
    if (remoteModels && remoteModels.length > 0) {
      return remoteModels;
    }

    // 否则使用默认模型列表，并应用本地映射
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
      return CLAUDE_MODELS.map((m) => {
        if (m.id === 'claude-sonnet-4-5' && mapping.sonnet && String(mapping.sonnet).trim().length > 0) {
          return { ...m, label: String(mapping.sonnet) };
        }
        if (m.id === 'claude-opus-4-5-20251101' && mapping.opus && String(mapping.opus).trim().length > 0) {
          return { ...m, label: String(mapping.opus) };
        }
        if (m.id === 'claude-haiku-4-5' && mapping.haiku && String(mapping.haiku).trim().length > 0) {
          return { ...m, label: String(mapping.haiku) };
        }
        return m;
      });
    } catch {
      return CLAUDE_MODELS;
    }
  }, [currentProvider, remoteModels]);

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
   * TODO: 临时隐藏模式选择器,后续恢复
   */
  // const handleModeSelect = useCallback((mode: PermissionMode) => {
  //   onModeSelect?.(mode);
  // }, [onModeSelect]);

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
        {/* TODO: 临时隐藏模式选择器,后续恢复 */}
        {/* <ModeSelect value={permissionMode} onChange={handleModeSelect} /> */}
        <ProviderSelect value={currentProvider} onChange={handleProviderSelect} />
        <ModelSelect value={selectedModel} onChange={handleModelSelect} models={availableModels} currentProvider={currentProvider} />
      </div>

      {/* 右侧：工具按钮 */}
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
