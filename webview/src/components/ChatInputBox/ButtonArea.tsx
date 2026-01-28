import { useCallback, useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ButtonAreaProps, ModelInfo, PermissionMode, ReasoningEffort } from './types';
import { ConfigSelect, ModelSelect, ModeSelect, ReasoningSelect } from './selectors';
import { CLAUDE_MODELS, CODEX_MODELS } from './types';
import { STORAGE_KEYS, validateCodexCustomModels } from '../../types/provider';

/**
 * 从 localStorage 获取自定义 Codex 模型列表
 * 使用运行时类型验证确保数据安全
 */
function getCustomCodexModels(): ModelInfo[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored);
    // 使用运行时类型验证
    const validModels = validateCodexCustomModels(parsed);
    return validModels.map(m => ({
      id: m.id,
      label: m.label || m.id,
      description: m.description,
    }));
  } catch {
    return [];
  }
}

/**
 * ButtonArea - 底部工具栏组件
 * 包含模式选择、模型选择、附件按钮、增强提示词按钮、发送/停止按钮
 */
export const ButtonArea = ({
  disabled = false,
  hasInputContent = false,
  isLoading = false,
  isEnhancing = false,
  selectedModel = 'claude-sonnet-4-5',
  permissionMode = 'bypassPermissions',
  currentProvider = 'claude',
  reasoningEffort = 'medium',
  onSubmit,
  onStop,
  onModeSelect,
  onModelSelect,
  onProviderSelect,
  onReasoningChange,
  onEnhancePrompt,
  alwaysThinkingEnabled = false,
  onToggleThinking,
  streamingEnabled = true,
  onStreamingEnabledChange,
  selectedAgent,
  onAgentSelect,
  onOpenAgentSettings,
}: ButtonAreaProps) => {
  const { t } = useTranslation();
  // const fileInputRef = useRef<HTMLInputElement>(null);

  // 用于追踪 localStorage 中自定义模型的变化
  // 当 localStorage 发生变化时，通过更新此版本号触发 useMemo 重新计算
  const [customModelsVersion, setCustomModelsVersion] = useState(0);

  // 监听 localStorage 变化（跨标签页同步 + 同标签页自定义事件）
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.CODEX_CUSTOM_MODELS || e.key === STORAGE_KEYS.CLAUDE_MODEL_MAPPING) {
        setCustomModelsVersion(v => v + 1);
      }
    };

    // 监听自定义事件（同标签页内的 localStorage 变化）
    const handleCustomStorageChange = (e: CustomEvent<{ key: string }>) => {
      if (e.detail.key === STORAGE_KEYS.CODEX_CUSTOM_MODELS || e.detail.key === STORAGE_KEYS.CLAUDE_MODEL_MAPPING) {
        setCustomModelsVersion(v => v + 1);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('localStorageChange', handleCustomStorageChange as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('localStorageChange', handleCustomStorageChange as EventListener);
    };
  }, []);

  /**
   * 应用模型名称映射
   * 将基础模型 ID 映射为实际的模型名称（如带容量后缀的版本）
   */
  const applyModelMapping = useCallback((model: ModelInfo, mapping: { haiku?: string; sonnet?: string; opus?: string }): ModelInfo => {
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
  }, []);

  // 根据当前提供商选择模型列表
  // customModelsVersion 用于在 localStorage 变化时触发重新计算
  const availableModels = useMemo(() => {
    if (currentProvider === 'codex') {
      // 合并内置模型和自定义模型
      const customModels = getCustomCodexModels();
      if (customModels.length === 0) {
        return CODEX_MODELS;
      }
      // 自定义模型放在前面，内置模型放在后面
      // 过滤掉与自定义模型重复的内置模型
      const customIds = new Set(customModels.map(m => m.id));
      const filteredBuiltIn = CODEX_MODELS.filter(m => !customIds.has(m.id));
      return [...customModels, ...filteredBuiltIn];
    }
    if (typeof window === 'undefined' || !window.localStorage) {
      return CLAUDE_MODELS;
    }
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING);
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
  }, [currentProvider, applyModelMapping, customModelsVersion]);

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

  /**
   * 处理思考深度选择 (Codex only)
   */
  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    onReasoningChange?.(effort);
  }, [onReasoningChange]);

  /**
   * 处理增强提示词按钮点击
   */
  const handleEnhanceClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEnhancePrompt?.();
  }, [onEnhancePrompt]);

  return (
    <div className="button-area" data-provider={currentProvider}>
      {/* 左侧：选择器 */}
      <div className="button-area-left">
        <ConfigSelect
          currentProvider={currentProvider}
          onProviderChange={handleProviderSelect}
          alwaysThinkingEnabled={alwaysThinkingEnabled}
          onToggleThinking={onToggleThinking}
          streamingEnabled={streamingEnabled}
          onStreamingEnabledChange={onStreamingEnabledChange}
          selectedAgent={selectedAgent}
          onAgentSelect={onAgentSelect}
          onOpenAgentSettings={onOpenAgentSettings}
        />
        <ModeSelect value={permissionMode} onChange={handleModeSelect} provider={currentProvider} />
        <ModelSelect value={selectedModel} onChange={handleModelSelect} models={availableModels} currentProvider={currentProvider} />
        {currentProvider === 'codex' && (
          <ReasoningSelect value={reasoningEffort} onChange={handleReasoningChange} />
        )}
      </div>

      {/* 右侧:工具按钮 */}
      <div className="button-area-right">
        <div className="button-divider" />

        {/* 增强提示词按钮 */}
        <button
          className="enhance-prompt-button has-tooltip"
          onClick={handleEnhanceClick}
          disabled={disabled || !hasInputContent || isLoading || isEnhancing}
          data-tooltip={`${t('promptEnhancer.tooltip')} (${t('promptEnhancer.shortcut')})`}
        >
          <span className={`codicon ${isEnhancing ? 'codicon-loading codicon-modifier-spin' : 'codicon-sparkle'}`} />
        </button>

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
