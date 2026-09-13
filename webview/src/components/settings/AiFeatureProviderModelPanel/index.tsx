import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_PROVIDERS } from '../../ChatInputBox/types';
import type { ModelInfo } from '../../ChatInputBox/types';
import { resolveProviderModels } from '../../ChatInputBox/resolveProviderModels';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { usePluginModels } from '../hooks/usePluginModels';
import { useCliModels } from '../../../hooks/providers/useCliModels';
import { STORAGE_KEYS } from '../../../types/provider';
import { readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import type { AiFeatureConfig, AiFeatureProvider } from '../../../types/aiFeatureConfig';
import { AI_FEATURE_PROVIDERS, isAiFeatureProvider } from '../../../types/aiFeatureConfig';
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

interface SelectOption {
  value: string;
  label: string;
}

type SelectionMode = 'auto' | 'manual';

/**
 * Custom listbox select — native <select> popups are unreliable in JCEF
 * (hit-testing breaks with overlays / disabled options / overflow).
 * Same pattern as DependencySection VersionSelect and BehaviorTab SoundSelect.
 */
const FeatureSelect = ({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  icon,
  testId,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  icon?: ReactNode;
  testId?: string;
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  return (
    <div className={styles.selectWrap} ref={containerRef} data-testid={testId}>
      {icon && (
        <span className={styles.iconWrap} aria-hidden="true">
          {icon}
        </span>
      )}
      <button
        type="button"
        className={`${styles.selectTrigger} ${open ? styles.open : ''} ${icon ? styles.withIcon : ''}`}
        onClick={() => {
          if (!disabled) {
            setOpen((prev) => !prev);
          }
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={styles.selectValue}>{selectedLabel}</span>
        <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
      </button>

      {open && (
        <div className={styles.dropdown} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`${styles.option} ${selected ? styles.selected : ''}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className={styles.optionLabel}>{option.label}</span>
                {selected && <span className="codicon codicon-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

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

  const statusProviderLabel = t(`providers.${statusProvider}.label`, {
    defaultValue: t(`${providerKeyPrefix}.${statusProvider}`, { defaultValue: statusProvider }),
  });

  const autoSummaryText = config.resolutionSource === 'unavailable' || !config.effectiveProvider
    ? t(`${settingsKeyPrefix}.autoUnavailable`)
    : t(`${settingsKeyPrefix}.autoSummary`, { provider: statusProviderLabel });

  const manualStatusText = config.resolutionSource === 'unavailable'
    ? t(`${settingsKeyPrefix}.currentProviderUnavailable`, {
      provider: statusProviderLabel,
    })
    : null;

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
      <div className={styles.modeRow}>
        <span className={styles.modeLabel} id={`${settingsKeyPrefix}-mode-label`}>
          {t(`${settingsKeyPrefix}.modeLabel`)}
        </span>
        <div
          className={styles.segmentedControl}
          role="group"
          aria-labelledby={`${settingsKeyPrefix}-mode-label`}
          data-testid="ai-feature-mode-segment"
        >
          <button
            type="button"
            className={selectionMode === 'auto' ? styles.segmentActive : styles.segment}
            aria-pressed={selectionMode === 'auto'}
            data-testid="ai-feature-mode-auto"
            onClick={() => handleModeChange('auto')}
          >
            {t(`${settingsKeyPrefix}.modeAuto`)}
          </button>
          <button
            type="button"
            className={selectionMode === 'manual' ? styles.segmentActive : styles.segment}
            aria-pressed={selectionMode === 'manual'}
            data-testid="ai-feature-mode-manual"
            onClick={() => handleModeChange('manual')}
          >
            {t(`${settingsKeyPrefix}.modeManual`)}
          </button>
        </div>
      </div>

      {isAutoMode ? (
        <div
          className={`${styles.autoSummary} ${
            config.resolutionSource === 'unavailable' || !config.effectiveProvider
              ? styles.autoSummaryWarn
              : ''
          }`}
          data-testid="ai-feature-auto-summary"
          aria-live="polite"
        >
          {config.effectiveProvider && (
            <span className={styles.autoSummaryIcon} aria-hidden="true">
              <ProviderModelIcon providerId={config.effectiveProvider} size={16} colored />
            </span>
          )}
          {!config.effectiveProvider && (
            <span className={`codicon codicon-warning ${styles.autoSummaryIcon}`} aria-hidden="true" />
          )}
          <div className={styles.autoSummaryBody}>
            {config.effectiveProvider && (
              <span className={styles.autoSummaryTitle}>{statusProviderLabel}</span>
            )}
            <span className={styles.autoSummaryText}>{autoSummaryText}</span>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.selectGroup}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t(`${settingsKeyPrefix}.label`)}</span>
              <FeatureSelect
                value={selectedProvider}
                options={providerOptions}
                onChange={(value) => {
                  if (isAiFeatureProvider(value)) {
                    onProviderChange(value);
                  }
                }}
                ariaLabel={t(`${settingsKeyPrefix}.label`)}
                testId="ai-feature-provider-select"
                icon={(
                  <span data-testid="provider-select-icon">
                    <ProviderModelIcon providerId={selectedProvider} size={14} colored />
                  </span>
                )}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t(`${settingsKeyPrefix}.modelLabel`)}</span>
              <FeatureSelect
                value={resolvedModelValue}
                options={modelSelectOptions}
                onChange={onModelChange}
                disabled={modelSelectOptions.length === 0}
                ariaLabel={t(`${settingsKeyPrefix}.modelLabel`)}
                testId="ai-feature-model-select"
                icon={(
                  <ProviderModelIcon
                    providerId={selectedProvider}
                    modelId={currentModel}
                    size={14}
                    colored
                  />
                )}
              />
            </div>
          </div>

          {manualStatusText && (
            <div
              className={`${styles.statusHint} ${styles.statusHintWarn}`}
              data-testid="ai-feature-status-hint"
            >
              <span className="codicon codicon-warning" />
              <span className={styles.statusText} title={manualStatusText}>{manualStatusText}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AiFeatureProviderModelPanel;
