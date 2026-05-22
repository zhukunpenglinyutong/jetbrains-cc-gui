import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../ChatInputBox/types';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import type { AiFeatureConfig, AiFeatureProvider } from '../../../types/aiFeatureConfig';
import styles from './style.module.less';

const OTHER_MODEL_OPTION = '__other__';

interface AiFeatureProviderModelPanelProps {
  config: AiFeatureConfig;
  settingsKeyPrefix: string;
  providerKeyPrefix: string;
  fallbackProvider?: AiFeatureProvider;
  onProviderChange?: (provider: AiFeatureProvider) => void;
  onModelChange?: (model: string) => void;
  onResetToDefault?: () => void;
}

const AiFeatureProviderModelPanel = ({
  config,
  settingsKeyPrefix,
  providerKeyPrefix,
  fallbackProvider = 'codex',
  onProviderChange = () => {},
  onModelChange = () => {},
  onResetToDefault = () => {},
}: AiFeatureProviderModelPanelProps) => {
  const { t } = useTranslation();

  const selectedProvider = config.provider
    ?? config.effectiveProvider
    ?? fallbackProvider;
  const statusProvider = config.effectiveProvider ?? config.provider ?? fallbackProvider;
  const modelOptions = selectedProvider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
  const modelOptionIds = useMemo(() => new Set(modelOptions.map((model) => model.id)), [modelOptions]);
  const currentModel = config.models[selectedProvider] ?? '';
  const [selectedModelOption, setSelectedModelOption] = useState(() => (
    modelOptionIds.has(currentModel) ? currentModel : OTHER_MODEL_OPTION
  ));
  const [customModelValue, setCustomModelValue] = useState(currentModel);
  const isAutoMode = config.provider == null;
  const statusText = config.resolutionSource === 'auto'
    ? t(`${settingsKeyPrefix}.currentProviderAuto`, {
      provider: t(`${providerKeyPrefix}.${statusProvider}`),
    })
    : config.resolutionSource === 'manual'
      ? t(`${settingsKeyPrefix}.currentProviderManual`, {
        provider: t(`${providerKeyPrefix}.${statusProvider}`),
      })
      : t(`${settingsKeyPrefix}.currentProviderUnavailable`, {
        provider: t(`${providerKeyPrefix}.${statusProvider}`),
      });

  const getProviderLabel = useCallback((provider: AiFeatureProvider) => {
    return t(`${providerKeyPrefix}.${provider}`);
  }, [t, providerKeyPrefix]);

  useEffect(() => {
    if (modelOptionIds.has(currentModel)) {
      setSelectedModelOption(currentModel);
      setCustomModelValue(currentModel);
      return;
    }

    setSelectedModelOption(OTHER_MODEL_OPTION);
    setCustomModelValue(currentModel);
  }, [currentModel, modelOptionIds]);

  const handleModelSelectChange = useCallback((value: string) => {
    if (value === OTHER_MODEL_OPTION) {
      setSelectedModelOption(OTHER_MODEL_OPTION);
      setCustomModelValue((previousValue) => previousValue || currentModel);
      return;
    }

    setSelectedModelOption(value);
    setCustomModelValue(value);
    onModelChange(value);
  }, [currentModel, onModelChange]);

  const handleCustomModelChange = useCallback((value: string) => {
    setSelectedModelOption(OTHER_MODEL_OPTION);
    setCustomModelValue(value);
    onModelChange(value);
  }, [onModelChange]);

  return (
    <div className={styles.panel}>
      <div className={styles.selectGroup}>
        <div className={styles.selectWrap}>
          <span className={styles.iconWrap} data-testid="provider-select-icon" aria-hidden="true">
            <ProviderModelIcon providerId={selectedProvider} size={14} colored />
          </span>
          <select
            className={styles.providerSelect}
            value={selectedProvider}
            onChange={(e) => onProviderChange(e.target.value as AiFeatureProvider)}
            aria-label={t(`${settingsKeyPrefix}.label`)}
          >
            {(['claude', 'codex'] as AiFeatureProvider[]).map((provider) => (
              <option key={provider} value={provider} disabled={!config.availability[provider]}>
                {getProviderLabel(provider)}{!config.availability[provider] ? ` (${t(`${settingsKeyPrefix}.providerUnavailable`)})` : ''}
              </option>
            ))}
          </select>
          <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
        </div>

        <div className={styles.selectWrap}>
          <select
            id={`${settingsKeyPrefix}-model`}
            className={styles.modelSelect}
            value={selectedModelOption}
            onChange={(e) => handleModelSelectChange(e.target.value)}
            aria-label={t(`${settingsKeyPrefix}.modelLabel`)}
          >
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
            <option value={OTHER_MODEL_OPTION}>
              {t(`${settingsKeyPrefix}.otherModelOption`)}
            </option>
          </select>
          <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
        </div>

        {selectedModelOption === OTHER_MODEL_OPTION && (
          <div className={styles.customModelSection}>
            <label
              className={styles.customModelLabel}
              htmlFor={`${settingsKeyPrefix}-custom-model`}
            >
              {t(`${settingsKeyPrefix}.customModelLabel`)}
            </label>
            <input
              id={`${settingsKeyPrefix}-custom-model`}
              className={styles.customModelInput}
              value={customModelValue}
              onChange={(e) => handleCustomModelChange(e.target.value)}
              placeholder={t(`${settingsKeyPrefix}.customModelPlaceholder`)}
              aria-label={t(`${settingsKeyPrefix}.customModelLabel`)}
            />
            <small className={styles.customModelHint}>
              <span className="codicon codicon-info" />
              <span>{t(`${settingsKeyPrefix}.customModelHint`)}</span>
            </small>
          </div>
        )}
      </div>

      <div className={styles.actionsRow} data-testid="ai-feature-actions-row">
        <div className={styles.statusHint} data-testid="ai-feature-status-hint">
          <span className="codicon codicon-info" />
          <span className={styles.statusText} title={statusText}>{statusText}</span>
        </div>

        <button
          type="button"
          className={styles.resetBtn}
          onClick={onResetToDefault}
          disabled={isAutoMode}
          aria-label={t(`${settingsKeyPrefix}.resetToDefault`)}
        >
          {t(`${settingsKeyPrefix}.resetToDefault`)}
        </button>
      </div>
    </div>
  );
};

export default AiFeatureProviderModelPanel;
