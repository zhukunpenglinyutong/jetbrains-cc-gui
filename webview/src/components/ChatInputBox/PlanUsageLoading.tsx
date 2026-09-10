import type { TFunction } from 'i18next';

interface PlanUsageLoadingProps {
  t: TFunction;
}

/** Loading placeholder shown while usage is being fetched. */
export const PlanUsageLoading = ({ t }: PlanUsageLoadingProps) => {
  const label = t('chat.planUsage.loading', { defaultValue: 'Loading usage…' });
  return (
    <div
      className="plan-usage loading has-tooltip"
      data-tooltip={label}
      aria-label={label}
    >
      <span className="plan-usage-label">…</span>
    </div>
  );
};
