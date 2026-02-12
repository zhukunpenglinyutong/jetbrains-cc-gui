import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Claude, OpenAI, Gemini } from '@lobehub/icons';
import { AVAILABLE_MODELS } from '../types';
import type { ModelInfo } from '../types';
import { STORAGE_KEYS } from '../../../types/provider';

interface ModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
  models?: ModelInfo[];  // 新增: 可选的动态模型列表
  currentProvider?: string;  // 当前提供商类型
}

const DEFAULT_MODEL_MAP: Record<string, ModelInfo> = AVAILABLE_MODELS.reduce(
  (acc, model) => {
    acc[model.id] = model;
    return acc;
  },
  {} as Record<string, ModelInfo>
);

const MODEL_LABEL_KEYS: Record<string, string> = {
  'claude-sonnet-4-5': 'models.claude.sonnet45.label',
  'claude-opus-4-6': 'models.claude.opus46.label',
  'claude-opus-4-6[1m]': 'models.claude.opus46_1m.label',
  'claude-opus-4-5-20251101': 'models.claude.opus45.label',
  'claude-haiku-4-5': 'models.claude.haiku45.label',
  'gpt-5.3-codex': 'models.codex.gpt53codex.label',
  'gpt-5.3': 'models.codex.gpt53.label',
  'gpt-5.2-codex': 'models.codex.gpt52codex.label',
  'gpt-5.1-codex-max': 'models.codex.gpt51codexMax.label',
  'gpt-5.1-codex-mini': 'models.codex.gpt51codexMini.label',
  'gpt-5.2': 'models.codex.gpt52.label',
};

const MODEL_DESCRIPTION_KEYS: Record<string, string> = {
  'claude-sonnet-4-5': 'models.claude.sonnet45.description',
  'claude-opus-4-6': 'models.claude.opus46.description',
  'claude-opus-4-6[1m]': 'models.claude.opus46_1m.description',
  'claude-opus-4-5-20251101': 'models.claude.opus45.description',
  'claude-haiku-4-5': 'models.claude.haiku45.description',
  'gpt-5.3-codex': 'models.codex.gpt53codex.description',
  'gpt-5.3': 'models.codex.gpt53.description',
  'gpt-5.2-codex': 'models.codex.gpt52codex.description',
  'gpt-5.1-codex-max': 'models.codex.gpt51codexMax.description',
  'gpt-5.1-codex-mini': 'models.codex.gpt51codexMini.description',
  'gpt-5.2': 'models.codex.gpt52.description',
};

/**
 * Maps model IDs to mapping keys for looking up actual model names
 * from the 'claude-model-mapping' localStorage entry.
 * The opus 1M variant uses a separate 'opus_1m' key, falling back to 'opus'.
 */
const MODEL_ID_TO_MAPPING_KEY: Record<string, string> = {
  'claude-sonnet-4-5': 'sonnet',
  'claude-opus-4-6': 'opus',
  'claude-opus-4-6[1m]': 'opus_1m',
  'claude-opus-4-5-20251101': 'opus',
  'claude-haiku-4-5': 'haiku',
};

/**
 * Retrieves model mapping from localStorage.
 * Returns format: { main: '', haiku: '', sonnet: '', opus: '' }
 */
const getModelMapping = (): Record<string, string> => {
  try {
    const mappingStr = localStorage.getItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING);
    if (mappingStr) {
      return JSON.parse(mappingStr);
    }
  } catch {
    // ignore parse errors
  }
  return {};
};

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
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentModel = models.find(m => m.id === value) || models[0];

  // Cache model mapping to avoid redundant localStorage reads on every render
  const modelMapping = useMemo(() => getModelMapping(), []);

  const getModelLabel = (model: ModelInfo): string => {
    // Check model mapping first (from local settings.json or provider config)
    const mappingKey = MODEL_ID_TO_MAPPING_KEY[model.id];
    if (mappingKey) {
      // opus_1m falls back to opus mapping
      const mappedName = modelMapping[mappingKey]
        || (mappingKey === 'opus_1m' ? modelMapping['opus'] : undefined);
      if (mappedName && mappedName.trim()) {
        return mappedName.trim();
      }
    }

    // Fall back to default logic when no mapping is found
    const defaultModel = DEFAULT_MODEL_MAP[model.id];
    const labelKey = MODEL_LABEL_KEYS[model.id];
    const hasCustomLabel = defaultModel && model.label && model.label !== defaultModel.label;

    if (hasCustomLabel) {
      return model.label;
    }

    if (labelKey) {
      return t(labelKey);
    }

    return model.label;
  };

  const getModelDescription = (model: ModelInfo): string | undefined => {
    const descriptionKey = MODEL_DESCRIPTION_KEYS[model.id];
    if (descriptionKey) {
      return t(descriptionKey);
    }
    return model.description;
  };

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
        title={t('chat.currentModel', { model: getModelLabel(currentModel) })}
      >
        <ModelIcon provider={currentProvider} size={12} />
        <span className="selector-button-text">{getModelLabel(currentModel)}</span>
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
                <span>{getModelLabel(model)}</span>
                {getModelDescription(model) && (
                  <span className="model-description">{getModelDescription(model)}</span>
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
