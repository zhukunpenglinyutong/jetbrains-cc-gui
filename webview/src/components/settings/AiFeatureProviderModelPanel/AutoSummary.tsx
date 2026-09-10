import { useTranslation } from 'react-i18next';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import type { AiFeatureConfig, AiFeatureProvider } from '../../../types/aiFeatureConfig';
import styles from './style.module.less';

const AutoSummary = ({
  config,
  settingsKeyPrefix,
  providerKeyPrefix,
  statusProvider,
}: {
  config: AiFeatureConfig;
  settingsKeyPrefix: string;
  providerKeyPrefix: string;
  statusProvider: AiFeatureProvider;
}) => {
  const { t } = useTranslation();

  const statusProviderLabel = t(`providers.${statusProvider}.label`, {
    defaultValue: t(`${providerKeyPrefix}.${statusProvider}`, { defaultValue: statusProvider }),
  });

  const autoSummaryText = config.resolutionSource === 'unavailable' || !config.effectiveProvider
    ? t(`${settingsKeyPrefix}.autoUnavailable`)
    : t(`${settingsKeyPrefix}.autoSummary`, { provider: statusProviderLabel });

  return (
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
  );
};

export default AutoSummary;
