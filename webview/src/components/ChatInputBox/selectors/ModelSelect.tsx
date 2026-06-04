import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_MODELS, normalizeClaudeModelId, modelSupports1MContext, strip1MContextSuffix } from '../types';
import type { ModelInfo } from '../types';
import { readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import Switch from 'antd/es/switch';
import Input from 'antd/es/input';
import './ModelSelect.less';
import { sendBridgeEvent } from '../../../utils/bridge';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };

const SEARCH_INPUT_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  width: '100%',
  boxSizing: 'border-box',
  border: 'none',
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--dropdown-bg)',
  color: 'var(--text-primary)'
};
const LONG_CONTEXT_OPTION_STYLE: React.CSSProperties = { justifyContent: 'space-between', cursor: 'default' };
const LONG_CONTEXT_LABEL_STYLE: React.CSSProperties = { fontSize: '12px' };

interface ModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
  models?: ModelInfo[];
  currentProvider?: string;
  onAddModel?: () => void;
  longContextEnabled?: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  error?: string;
  isLoading?: boolean;
  onRefresh?: () => void;
}

const DEFAULT_MODEL_MAP: Record<string, ModelInfo> = AVAILABLE_MODELS.reduce(
  (acc, model) => {
    acc[model.id] = model;
    return acc;
  },
  {} as Record<string, ModelInfo>
);

const MODEL_LABEL_KEYS: Record<string, string> = {
  'claude-sonnet-4-6': 'models.claude.sonnet46.label',
  'claude-opus-4-8': 'models.claude.opus48.label',
  'claude-opus-4-7': 'models.claude.opus46.label',
  'claude-opus-4-6': 'models.claude.opus46_1m.label',
  'claude-opus-4-6[1m]': 'models.claude.opus46_1m.label',
  'claude-haiku-4-5': 'models.claude.haiku45.label',
  'gpt-5.5': 'models.codex.gpt55.label',
  'gpt-5.4': 'models.codex.gpt54.label',
  'gpt-5.2-codex': 'models.codex.gpt52codex.label',
  'gpt-5.1-codex-max': 'models.codex.gpt51codexMax.label',
  'gpt-5.4-mini': 'models.codex.gpt54mini.label',
  'gpt-5.3-codex': 'models.codex.gpt53codex.label',
  'gpt-5.3-codex-spark': 'models.codex.gpt53codexSpark.label',
  'gpt-5.2': 'models.codex.gpt52.label',
  'gpt-5.1-codex-mini': 'models.codex.gpt51codexMini.label',
};

const MODEL_DESCRIPTION_KEYS: Record<string, string> = {
  'claude-sonnet-4-6': 'models.claude.sonnet46.description',
  'claude-opus-4-8': 'models.claude.opus48.description',
  'claude-opus-4-7': 'models.claude.opus46.description',
  'claude-opus-4-6': 'models.claude.opus46_1m.description',
  'claude-opus-4-6[1m]': 'models.claude.opus46_1m.description',
  'claude-haiku-4-5': 'models.claude.haiku45.description',
  'gpt-5.5': 'models.codex.gpt55.description',
  'gpt-5.4': 'models.codex.gpt54.description',
  'gpt-5.2-codex': 'models.codex.gpt52codex.description',
  'gpt-5.1-codex-max': 'models.codex.gpt51codexMax.description',
  'gpt-5.4-mini': 'models.codex.gpt54mini.description',
  'gpt-5.3-codex': 'models.codex.gpt53codex.description',
  'gpt-5.3-codex-spark': 'models.codex.gpt53codexSpark.description',
  'gpt-5.2': 'models.codex.gpt52.description',
  'gpt-5.1-codex-mini': 'models.codex.gpt51codexMini.description',
};

/**
 * Maps model IDs to mapping keys for looking up actual model names
 * from the 'claude-model-mapping' localStorage entry.
 * Legacy Opus 4.6 IDs share the same opus mapping bucket.
 */
const MODEL_ID_TO_MAPPING_KEY: Record<string, string> = {
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-8': 'opus',
  'claude-opus-4-7': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-opus-4-6[1m]': 'opus',
  'claude-haiku-4-5': 'haiku',
};

const resolveMappedModelName = (
  mappingKey: string | undefined,
  modelMapping: Record<string, string | undefined>
): string | undefined => {
  if (!mappingKey) {
    return modelMapping.main?.trim() || undefined;
  }

  const mapped = modelMapping[mappingKey]
    || (mappingKey === 'opus_1m' ? modelMapping.opus : undefined)
    || modelMapping.main;

  return mapped?.trim() || undefined;
};

/**
 * Resolve the display model name for icon matching.
 * For mapped Claude models, returns the mapped name; otherwise the original ID.
 */
const resolveModelIdForIcon = (
  modelId: string,
  modelMapping: Record<string, string | undefined>,
  mappingKeyMap: Record<string, string>
): string => {
  const mappingKey = mappingKeyMap[modelId];
  if (!mappingKey) {
    return modelId;
  }
  const mapped = resolveMappedModelName(mappingKey, modelMapping);
  if (mapped) {
    return mapped;
  }
  return modelId;
};

/**
 * ModelSelect - Model selector component
 * Supports switching between Sonnet 4.5, Opus 4.5, and other models, including Codex models
 */
export const ModelSelect = ({ value, onChange, models = AVAILABLE_MODELS, currentProvider = 'claude', onAddModel, longContextEnabled = true, onLongContextChange, error, isLoading, onRefresh }: ModelSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Strip [1m] suffix for finding the model in the list
  const strippedValue = strip1MContextSuffix(value);
  const normalizedValue = currentProvider === 'claude' ? normalizeClaudeModelId(strippedValue) : strippedValue;
  const currentModel = models.find(m => m.id === normalizedValue) || models.find(m => m.id === strippedValue) || models[0];
  const modelMapping = readClaudeModelMapping();

  const isSelectedModel = (modelId: string): boolean => {
    if (currentProvider !== 'claude') {
      return modelId === strippedValue;
    }
    return normalizeClaudeModelId(modelId) === normalizedValue;
  };

  const getModelLabel = (model: ModelInfo, show1MContext = false): string => {
    if (isLoading) {
      return t('models.loading');
    }
    if (error) {
      return t('models.error');
    }
    const mappingKey = MODEL_ID_TO_MAPPING_KEY[model.id];
    if (mappingKey) {
      const mappedName = resolveMappedModelName(mappingKey, modelMapping);
      if (mappedName) {
        return append1MContextSuffix(mappedName, model.id, show1MContext);
      }
    }

    const defaultModel = DEFAULT_MODEL_MAP[model.id];
    const labelKey = MODEL_LABEL_KEYS[model.id];
    const hasCustomLabel = defaultModel && model.label && model.label !== defaultModel.label;

    if (hasCustomLabel) {
      return append1MContextSuffix(model.label ?? '', model.id, show1MContext);
    }

    if (labelKey) {
      return append1MContextSuffix(t(labelKey), model.id, show1MContext);
    }

    return append1MContextSuffix(model.label ?? '', model.id, show1MContext);
  };

  const append1MContextSuffix = (label: string, modelId: string, show1MContext: boolean): string => {
    // Only show 1M context suffix for Claude provider
    if (currentProvider === 'claude' && show1MContext && modelSupports1MContext(modelId) && longContextEnabled) {
      return `${label} (${t('models.longContext.shortLabel')})`;
    }
    return label;
  };

  const getModelDescription = (model: ModelInfo): string | undefined => {
    const descriptionKey = MODEL_DESCRIPTION_KEYS[model.id];
    if (descriptionKey) {
      return t(descriptionKey);
    }
    return model.description;
  };

  const filteredModels = models.filter(model => {
    const label = getModelLabel(model, false).toLowerCase();
    const description = getModelDescription(model)?.toLowerCase() || '';
    const search = searchTerm.toLowerCase();
    return label.includes(search) || description.includes(search) || model.id.toLowerCase().includes(search);
  });

  const visibleModels = filteredModels.slice(0, 100);

  const inputRef = useRef<any>(null);
  const { positionedStyle, maxHeight: viewportMaxHeight, recalculate } = useDropdownPosition({
    buttonRef,
    preferredAlignment: 'right',
    minWidth: 320,
  });

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !isOpen;
    setIsOpen(next);
    if (next) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  /**
   * Select model
   */
  const handleSelect = useCallback((modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
    setSearchTerm('');
  }, [onChange]);

  /**
   * Close on outside click
   */
  useEffect(() => {
    if (!isOpen) return;

    // Focus without scrolling
    if (inputRef.current) {
      setTimeout(() => {
        inputRef.current?.focus({ preventScroll: true });
      }, 0);
    }

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

    // Delay adding event listener to prevent immediate trigger
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleOpenSettings = () => {
    sendBridgeEvent('show_settings', 'opencode');
    setIsOpen(false);
  };

  const handleRefresh = () => {
    onRefresh?.();
  };

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        title={error || t('chat.currentModel', { model: getModelLabel(currentModel, true) })}
        data-has-error={!!error}
      >
        <ProviderModelIcon
          providerId={currentProvider}
          modelId={resolveModelIdForIcon(currentModel.id, modelMapping, MODEL_ID_TO_MAPPING_KEY)}
          size={12}
          colored
        />
        <span className="selector-button-text">{getModelLabel(currentModel, true)}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...positionedStyle, maxHeight: viewportMaxHeight ? `${Math.min(400, viewportMaxHeight)}px` : '400px', overflowY: 'auto' }}
        >
          {error ? (
            <div className="selector-error">
              <span className="codicon codicon-warning" />
              <pre>{error}</pre>
              <div className="selector-error-actions">
                {onRefresh && (
                  <button onClick={handleRefresh}>
                    <span className="codicon codicon-refresh" />
                    <span>{t('common.retry', { defaultValue: 'Retry' })}</span>
                  </button>
                )}
                <button onClick={handleOpenSettings}>{t('settings.title')}</button>
              </div>
            </div>
          ) : isLoading ? (
            <div className="selector-empty">{t('models.loading')}</div>
          ) : (
            <>
              <Input
                ref={inputRef}
                style={SEARCH_INPUT_STYLE}
                placeholder={t('models.searchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              {visibleModels.length > 0 ? (
                <>
                  {visibleModels.map((model) => (
                    <div
                      key={model.id}
                      className={`selector-option ${isSelectedModel(model.id) ? 'selected' : ''}`}
                      onClick={() => handleSelect(model.id)}
                    >
                      <ProviderModelIcon
                        providerId={currentProvider}
                        modelId={resolveModelIdForIcon(model.id, modelMapping, MODEL_ID_TO_MAPPING_KEY)}
                        size={16}
                        colored
                      />
                      <div className="model-option-info">
                        <span className="model-name">{getModelLabel(model, false)}</span>
                        {getModelDescription(model) && (
                          <span className="model-description">{getModelDescription(model)}</span>
                        )}
                      </div>
                      {isSelectedModel(model.id) && (
                        <span className="codicon codicon-check check-mark" />
                      )}
                    </div>
                  ))}
                  {filteredModels.length > 100 && (
                    <div className="selector-empty" style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '8px 12px' }}>
                      {t('models.typeToSearchMore', { count: filteredModels.length - 100, defaultValue: `+ ${filteredModels.length - 100} more models. Type to search.` })}
                    </div>
                  )}
                </>
              ) : (
                <div className="selector-empty">{t('models.noModelsFound')}</div>
              )}
            </>
          )}
          {currentProvider === 'claude' && onLongContextChange && !error && !isLoading && (
            <>
              <div className="selector-divider" />
              <div
                className="selector-option"
                style={LONG_CONTEXT_OPTION_STYLE}
                onClick={(e) => e.stopPropagation()}
              >
                <span style={LONG_CONTEXT_LABEL_STYLE}>{t('models.longContext.shortLabel')}</span>
                <Switch
                  size="small"
                  checked={modelSupports1MContext(value) ? longContextEnabled : false}
                  disabled={!modelSupports1MContext(value)}
                  onChange={onLongContextChange}
                />
              </div>
            </>
          )}
          {onAddModel && !error && !isLoading && (
            <>
              <div className="selector-divider" />
              <div
                className="selector-option selector-option-add"
                onClick={() => { onAddModel(); setIsOpen(false); }}
              >
                <span className="codicon codicon-add selector-add-icon" />
                <span>{t('models.addModel')}</span>
              </div>
            </>
          )}
          {onRefresh && !error && (
            <>
              <div className="selector-divider" />
              <div
                className="selector-option selector-option-add"
                onClick={handleRefresh}
              >
                <span className={`codicon codicon-refresh ${isLoading ? 'codicon-modifier-spin' : ''}`} />
                <span>{t('models.refreshModels')}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ModelSelect;
