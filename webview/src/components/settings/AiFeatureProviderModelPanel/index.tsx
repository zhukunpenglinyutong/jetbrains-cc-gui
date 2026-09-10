import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_PROVIDERS } from '../../ChatInputBox/types';
import type { ModelInfo } from '../../ChatInputBox/types';
import { resolveProviderModels } from '../../ChatInputBox/resolveProviderModels';
import { usePluginModels } from '../hooks/usePluginModels';
import { useCliModels } from '../../../hooks/providers/useCliModels';
import { STORAGE_KEYS } from '../../../types/provider';
import { readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import type { AiFeatureConfig, AiFeatureProvider } from '../../../types/aiFeatureConfig';
import { AI_FEATURE_PROVIDERS, isAiFeatureProvider } from '../../../types/aiFeatureConfig';
import { type SelectOption } from './FeatureSelect';
import ModeSelector, { type SelectionMode } from './ModeSelector';
import AutoSummary from './AutoSummary';
import ManualSelection from './ManualSelection';
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

/** Chat CLI list order — only ids that are valid AI feature providers. */
const FEATURE_PROVIDER_INFOS = AVAILABLE_PROVIDERS.filter(
  (p): p is typeof p & { id: AiFeatureProvider } => isAiFeatureProvider(p.id),
);

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

  const isAutoMode = config.provider == null;
  const selectionMode: SelectionMode = isAutoMode ? 'auto' : 'manual';

  const selectedProvider = config.provider
    ?? config.effectiveProvider
    ?? fallbackProvider;
  const statusProvider = config.effectiveProvider ?? config.provider ?? fallbackProvider;
  // availability may be missing on partial payloads; never throw on lookup
  const availability = config.availability ?? Object.fromEntries(
    AI_FEATURE_PROVIDERS.map((p) => [p, false]),
  ) as AiFeatureConfig['availability'];

  // Same catalog source as main chat ModelSelect (useCliModels + resolveProviderModels).
  const { cliModels, cliCatalogHasEntries } = useCliModels(selectedProvider);

  // Shared resolver with chat toolbar — Prompt Enhancer and Commit AI both mount
  // this panel so they stay identical by construction.
  const claudeCustomModels = usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS).models;
  const codexCustomModels = usePluginModels(STORAGE_KEYS.CODEX_CUSTOM_MODELS).models;
  const availableModels = useMemo<ModelInfo[]>(() => {
    let claudeMapping = null;
    try {
      claudeMapping = readClaudeModelMapping();
    } catch {
      claudeMapping = null;
    }
    const toModelInfo = (m: { id: string; label?: string; description?: string }): ModelInfo => ({
      id: m.id,
      label: m.label || m.id,
      description: m.description,
    });
    return resolveProviderModels({
      provider: selectedProvider,
      cliModels,
      cliCatalogHasEntries,
      claudeCustomModels: claudeCustomModels.map(toModelInfo),
      codexCustomModels: codexCustomModels.map(toModelInfo),
      claudeMapping,
    });
  }, [selectedProvider, claudeCustomModels, codexCustomModels, cliModels, cliCatalogHasEntries]);

  const currentModel = config.models?.[selectedProvider] ?? '';
  const currentModelInList = availableModels.some((m) => m.id === currentModel);
  // If the saved model isn't in the list (e.g. a custom id), still show it as an option.
  const modelOptions: ModelInfo[] = (!currentModelInList && currentModel)
    ? [{ id: currentModel, label: currentModel }, ...availableModels]
    : availableModels;

  const getProviderLabel = useCallback((provider: AiFeatureProvider, beta?: boolean) => {
    const base = t(`providers.${provider}.label`, {
      defaultValue: t(`${providerKeyPrefix}.${provider}`, { defaultValue: provider }),
    });
    const betaSuffix = beta ? ` (${t('providers.beta.badge', { defaultValue: 'Beta' })})` : '';
    const available = availability[provider];
    const unavailableSuffix = !available
      ? ` (${t(`${settingsKeyPrefix}.providerUnavailable`)})`
      : '';
    return `${base}${betaSuffix}${unavailableSuffix}`;
  }, [availability, providerKeyPrefix, settingsKeyPrefix, t]);

  // Never gate options by availability — settings should always allow choosing a
  // preferred provider; the status hint explains unavailability.
  // Order and membership match the main chat CLI selector (AVAILABLE_PROVIDERS).
  const providerOptions = useMemo<SelectOption[]>(
    () => FEATURE_PROVIDER_INFOS.map((provider) => ({
      value: provider.id,
      label: getProviderLabel(provider.id, provider.beta),
    })),
    [getProviderLabel],
  );

  const modelSelectOptions = useMemo<SelectOption[]>(
    () => modelOptions.map((model) => ({ value: model.id, label: model.label })),
    [modelOptions],
  );

  const resolvedModelValue = currentModel || modelOptions[0]?.id || '';

  const handleModeChange = useCallback((mode: SelectionMode) => {
    if (mode === selectionMode) {
      return;
    }
    if (mode === 'auto') {
      onResetToDefault();
      return;
    }
    // Pin the currently resolved provider when leaving auto.
    onProviderChange(statusProvider);
  }, [onProviderChange, onResetToDefault, selectionMode, statusProvider]);

  return (
    <div className={styles.panel}>
      <ModeSelector
        settingsKeyPrefix={settingsKeyPrefix}
        selectionMode={selectionMode}
        onModeChange={handleModeChange}
      />

      {isAutoMode ? (
        <AutoSummary
          config={config}
          settingsKeyPrefix={settingsKeyPrefix}
          providerKeyPrefix={providerKeyPrefix}
          statusProvider={statusProvider}
        />
      ) : (
        <ManualSelection
          settingsKeyPrefix={settingsKeyPrefix}
          providerKeyPrefix={providerKeyPrefix}
          statusProvider={statusProvider}
          resolutionUnavailable={config.resolutionSource === 'unavailable'}
          selectedProvider={selectedProvider}
          providerOptions={providerOptions}
          onProviderChange={onProviderChange}
          modelValue={resolvedModelValue}
          modelOptions={modelSelectOptions}
          onModelChange={onModelChange}
          currentModel={currentModel}
        />
      )}
    </div>
  );
};

export default AiFeatureProviderModelPanel;
