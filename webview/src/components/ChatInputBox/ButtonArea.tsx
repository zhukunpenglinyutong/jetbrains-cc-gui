import { useCallback, useRef } from 'react';
import type { ButtonAreaProps, PermissionMode } from './types';
import { ModeSelect, ModelSelect } from './selectors';
import { TokenIndicator } from './TokenIndicator';

/**
 * ButtonArea - 底部工具栏组件
 * 包含模式选择、模型选择、使用量指示器、附件按钮、发送/停止按钮
 */
export const ButtonArea = ({
  disabled = false,
  hasInputContent = false,
  isLoading = false,
  selectedModel = 'claude-sonnet-4-5',
  permissionMode = 'default',
  usagePercentage = 0,
  usageUsedTokens,
  usageMaxTokens,
  showUsage = true,
  onSubmit,
  onStop,
  onAddAttachment,
  onModeSelect,
  onModelSelect,
}: ButtonAreaProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * 处理附件按钮点击
   */
  const handleAttachClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

  /**
   * 处理文件选择
   */
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      onAddAttachment?.(files);
    }
    // 清空 input 以允许重复选择同一文件
    e.target.value = '';
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

  return (
    <div className="button-area">
      {/* 左侧：选择器 */}
      <div className="button-area-left">
        <ModeSelect value={permissionMode} onChange={handleModeSelect} />
        <ModelSelect value={selectedModel} onChange={handleModelSelect} />
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
          title="添加附件"
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
            title="停止生成"
          >
            <span className="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button
            className="submit-button"
            onClick={handleSubmitClick}
            disabled={disabled || !hasInputContent}
            title="发送消息 (Enter)"
          >
            <span className="codicon codicon-send" />
          </button>
        )}
      </div>
    </div>
  );
};

export default ButtonArea;
