import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../ChatInputBox/types';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import type { AiFeatureConfig, AiFeatureProvider } from '../../../types/aiFeatureConfig';
import styles from './style.module.less';

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
            value={config.models[selectedProvider]}
            onChange={(e) => onModelChange(e.target.value)}
            aria-label={t(`${settingsKeyPrefix}.modelLabel`)}
          >
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
        </div>
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
