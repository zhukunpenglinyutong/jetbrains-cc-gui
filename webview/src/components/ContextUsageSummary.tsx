import { useTranslation } from 'react-i18next';
import { clampUsagePercentage } from '../utils/usagePercentage';
import { formatTokens } from './contextUsageUtils';

interface ContextUsageSummaryProps {
  descriptionId: string;
  model: string;
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  isAutoCompactEnabled: boolean;
  autoCompactThreshold?: number;
}

export function ContextUsageSummary({
  descriptionId,
  model,
  totalTokens,
  rawMaxTokens,
  percentage,
  isAutoCompactEnabled,
  autoCompactThreshold,
}: ContextUsageSummaryProps) {
  const { t } = useTranslation();
  const safePercentage = clampUsagePercentage(percentage);

  return (
    <div id={descriptionId} className="context-usage-summary">
      <span className="context-usage-model">{model}</span>
      <span className="context-usage-tokens">
        {formatTokens(totalTokens)} / {formatTokens(rawMaxTokens)} ({safePercentage}%)
      </span>
      {isAutoCompactEnabled && (
        <span className="context-usage-autocompact">
          {autoCompactThreshold && rawMaxTokens > 0
            ? t('contextUsage.autoCompactEnabledWithThreshold', {
                threshold: Math.round(clampUsagePercentage((autoCompactThreshold / rawMaxTokens) * 100)),
                defaultValue: 'Auto-compact: enabled ({{threshold}}%)',
              })
            : t('contextUsage.autoCompactEnabled', {
                defaultValue: 'Auto-compact: enabled',
              })}
        </span>
      )}
    </div>
  );
}
