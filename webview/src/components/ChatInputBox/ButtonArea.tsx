import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
// TODO: 临时隐藏模式选择器,后续恢复
// import type { ButtonAreaProps, PermissionMode } from './types';
import type { ButtonAreaProps } from './types';
// import { ModeSelect, ModelSelect } from './selectors';
import { ModelSelect, ProviderSelect } from './selectors';
import { TokenIndicator } from './TokenIndicator';
import { CLAUDE_MODELS, CODEX_MODELS } from './types';

/**
 * ButtonArea - 底部工具栏组件
 * 包含模式选择、模型选择、使用量指示器、附件按钮、发送/停止按钮
 */
export const ButtonArea = ({
  disabled = false,
  hasInputContent = false,
  isLoading = false,
  selectedModel = 'claude-sonnet-4-5',
  // TODO: 临时隐藏模式选择器,后续恢复
  // permissionMode = 'default',
  currentProvider = 'claude',
  usagePercentage = 0,
  usageUsedTokens,
  usageMaxTokens,
  showUsage = true,
  onSubmit,
  onStop,
  onAddAttachment,
  // TODO: 临时隐藏模式选择器,后续恢复
  // onModeSelect,
  onModelSelect,
  onProviderSelect,
}: ButtonAreaProps) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 根据当前提供商选择模型列表
  const availableModels = currentProvider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;

  /**
   * 处理附件按钮点击
   */
  const handleAttachClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    console.log('[ButtonArea] Attach button clicked, fileInputRef.current:', fileInputRef.current);

    // 确保文件输入存在
    if (!fileInputRef.current) {
      console.error('[ButtonArea] File input ref is null');
      return;
    }

    try {
      fileInputRef.current.click();
      console.log('[ButtonArea] File input clicked successfully');
    } catch (error) {
      console.error('[ButtonArea] Error clicking file input:', error);
    }
  }, []);

  /**
   * 处理文件选择
   */
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[ButtonArea] handleFileChange called');
    const files = e.target.files;
    console.log('[ButtonArea] Selected files:', files?.length, files);

    if (files && files.length > 0) {
      console.log('[ButtonArea] Calling onAddAttachment with files');
      onAddAttachment?.(files);
    } else {
      console.log('[ButtonArea] No files selected');
    }

    // 清空 input 以允许重复选择同一文件
    e.target.value = '';
    console.log('[ButtonArea] File input value cleared');
  }, [onAddAttachment]);

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
        {/* 使用量指示器 */}
        {showUsage && (
          (() => {
            try {
              console.log('[Frontend] ButtonArea TokenIndicator percentage:', usagePercentage, 'used:', usageUsedTokens, 'max:', usageMaxTokens);
            } catch (_) {}
            return (
              <TokenIndicator
                percentage={usagePercentage}
                usedTokens={usageUsedTokens}
                maxTokens={usageMaxTokens}
              />
            );
          })()
        )}

        {/* 附件按钮 */}
        <button
          className="attach-button"
          onClick={handleAttachClick}
          title={t('chat.addAttachment')}
          disabled={disabled || isLoading}
        >
          <span className="codicon codicon-attach" />
        </button>

        {/* 隐藏的文件输入 */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="attach-input"
          onChange={handleFileChange}
          accept="image/*,.pdf,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.hpp,.css,.html,.xml,.yaml,.yml"
        />

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
