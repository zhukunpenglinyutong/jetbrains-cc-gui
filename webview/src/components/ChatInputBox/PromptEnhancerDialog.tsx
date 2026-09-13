import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';
import type { EnhanceUsageInfo } from './hooks/usePromptEnhancer';

interface PromptEnhancerDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  originalPrompt: string;
  enhancedPrompt: string;
  usageInfo?: EnhanceUsageInfo | null;
  onUseEnhanced: () => void;
  onKeepOriginal: () => void;
  onClose: () => void;
  onOpenSettings?: () => void;
}

/**
 * PromptEnhancerDialog - Prompt enhancement dialog
 * Displays original and enhanced prompts, letting the user choose which version to use.
 * Shows which mode / CLI / model is performing the enhancement.
 */
export const PromptEnhancerDialog = ({
  isOpen,
  isLoading,
  originalPrompt,
  enhancedPrompt,
  usageInfo = null,
  onUseEnhanced,
  onKeepOriginal,
  onClose,
  onOpenSettings,
}: PromptEnhancerDialogProps) => {
  const { t } = useTranslation();

  // Handle keyboard events
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && enhancedPrompt) {
      e.preventDefault();
      onUseEnhanced();
    }
  }, [onClose, onUseEnhanced, enhancedPrompt]);

  useEffect(() => {
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) {
    return null;
  }

  // Close on overlay click
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

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

  const handleOpenSettings = () => {
    onOpenSettings?.();
  };

  return (
    <div className="prompt-enhancer-overlay" onClick={handleOverlayClick}>
      <div className="prompt-enhancer-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="prompt-enhancer-header">
          <div className="prompt-enhancer-title">
            <span className="codicon codicon-sparkle" />
            <h3>{t('promptEnhancer.title')}</h3>
          </div>
          <button className="prompt-enhancer-close" onClick={onClose} type="button" aria-label={t('common.close', { defaultValue: 'Close' })}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        {/* Usage meta: mode / CLI / model + settings shortcut */}
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
              onClick={handleOpenSettings}
              data-testid="prompt-enhancer-open-settings"
              title={t('promptEnhancer.openSettingsTooltip')}
            >
              <span className="codicon codicon-settings-gear" />
              <span>{t('promptEnhancer.openSettings')}</span>
            </button>
          )}
        </div>

        {/* Content area */}
        <div className="prompt-enhancer-content">
          {/* Original prompt */}
          <div className="prompt-section">
            <div className="prompt-section-header">
              <span className="codicon codicon-edit" />
              <span>{t('promptEnhancer.originalPrompt')}</span>
            </div>
            <div className="prompt-text original-prompt">
              {originalPrompt}
            </div>
          </div>

          {/* Enhanced prompt */}
          <div className="prompt-section">
            <div className="prompt-section-header">
              <span className="codicon codicon-sparkle" />
              <span>{t('promptEnhancer.enhancedPrompt')}</span>
            </div>
            <div className="prompt-text enhanced-prompt">
              {isLoading && !enhancedPrompt ? (
                <div className="prompt-loading">
                  <span className="codicon codicon-loading codicon-modifier-spin" />
                  <span>{t('promptEnhancer.enhancing')}</span>
                </div>
              ) : (
                <>
                  {enhancedPrompt || t('promptEnhancer.enhancing')}
                  {isLoading && enhancedPrompt ? (
                    <span className="prompt-streaming-cursor" aria-hidden="true">
                      <span className="codicon codicon-loading codicon-modifier-spin" />
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Footer buttons */}
        <div className="prompt-enhancer-footer">
          <button
            className="prompt-enhancer-btn secondary"
            onClick={onKeepOriginal}
            disabled={isLoading}
            type="button"
          >
            <span className="codicon codicon-close" />
            {t('promptEnhancer.keepOriginal')}
          </button>
          <button
            className="prompt-enhancer-btn primary"
            onClick={onUseEnhanced}
            disabled={!enhancedPrompt}
            type="button"
          >
            <span className="codicon codicon-check" />
            {t('promptEnhancer.useEnhanced')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PromptEnhancerDialog;
