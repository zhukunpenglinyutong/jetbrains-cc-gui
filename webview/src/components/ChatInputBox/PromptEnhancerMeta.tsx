import { useTranslation } from 'react-i18next';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';
import type { EnhanceUsageInfo } from './hooks/usePromptEnhancer';

interface PromptEnhancerMetaProps {
  usageInfo: EnhanceUsageInfo | null;
  onOpenSettings?: () => void;
}

/**
 * PromptEnhancerMeta - Usage meta row of the prompt enhancer dialog
 * Shows which mode / CLI / model is performing the enhancement, plus a settings shortcut.
 */
export const PromptEnhancerMeta = ({ usageInfo, onOpenSettings }: PromptEnhancerMetaProps) => {
  const { t } = useTranslation();

  const hasUsage = usageInfo != null;
  const resolutionSource = usageInfo?.resolutionSource ?? null;
  const isManual = resolutionSource === 'manual';
  const modeLabel = resolutionSource === 'unavailable'
    ? t('promptEnhancer.modeUnavailable', { defaultValue: t('promptEnhancer.modeAuto') })
    : isManual
      ? t('promptEnhancer.modeManual')
      : t('promptEnhancer.modeAuto');

  const providerId = usageInfo?.provider ?? null;
  const providerLabel = providerId
    ? t(`providers.${providerId}.label`, { defaultValue: providerId })
    : t('promptEnhancer.providerUnresolved');
  const modelLabel = usageInfo?.model?.trim() || t('promptEnhancer.modelUnresolved');

  return (
    <div className="prompt-enhancer-meta" data-testid="prompt-enhancer-meta">
      <div className="prompt-enhancer-meta-items">
        {hasUsage ? (
          <>
            <span
              className={`prompt-enhancer-meta-chip ${isManual ? 'is-manual' : 'is-auto'}`}
              data-testid="prompt-enhancer-mode"
              title={t('promptEnhancer.modeLabel')}
            >
              <span className={`codicon ${isManual ? 'codicon-pinned' : 'codicon-sync'}`} />
              {modeLabel}
            </span>
            <span className="prompt-enhancer-meta-separator" aria-hidden="true">·</span>
            <span
              className="prompt-enhancer-meta-chip is-provider"
              data-testid="prompt-enhancer-provider"
              title={t('promptEnhancer.providerLabel')}
            >
              {providerId ? (
                <ProviderModelIcon providerId={providerId} size={14} colored />
              ) : (
                <span className="codicon codicon-server-process" />
              )}
              <span className="prompt-enhancer-meta-text">{providerLabel}</span>
            </span>
            <span className="prompt-enhancer-meta-separator" aria-hidden="true">·</span>
            <span
              className="prompt-enhancer-meta-chip is-model"
              data-testid="prompt-enhancer-model"
              title={t('promptEnhancer.modelLabel')}
            >
              <span className="codicon codicon-symbol-misc" />
              <span className="prompt-enhancer-meta-text" title={modelLabel}>{modelLabel}</span>
            </span>
          </>
        ) : (
          <span className="prompt-enhancer-meta-chip is-loading" data-testid="prompt-enhancer-meta-loading">
            <span className="codicon codicon-loading codicon-modifier-spin" />
            {t('promptEnhancer.resolvingUsage')}
          </span>
        )}
      </div>
      {onOpenSettings && (
        <button
          type="button"
          className="prompt-enhancer-settings-btn"
          onClick={onOpenSettings}
          data-testid="prompt-enhancer-open-settings"
          title={t('promptEnhancer.openSettingsTooltip')}
        >
          <span className="codicon codicon-settings-gear" />
          <span>{t('promptEnhancer.openSettings')}</span>
        </button>
      )}
    </div>
  );
};
