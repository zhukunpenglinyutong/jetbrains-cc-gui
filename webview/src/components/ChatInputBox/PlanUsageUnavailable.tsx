import type { TFunction } from 'i18next';

interface PlanUsageUnavailableProps {
  tooltip: string;
  t: TFunction;
}

/** Fallback shown when no present usage data is available. */
export const PlanUsageUnavailable = ({ tooltip, t }: PlanUsageUnavailableProps) => (
  <div
    className="plan-usage unavailable has-tooltip"
    data-tooltip={tooltip}
    aria-label={tooltip}
  >
    <span className="plan-usage-label">
      {t('chat.planUsage.dash', { defaultValue: 'Usage —' })}
    </span>
  </div>
);
