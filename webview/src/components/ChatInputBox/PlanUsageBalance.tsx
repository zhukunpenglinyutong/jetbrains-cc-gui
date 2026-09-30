import type { TFunction } from 'i18next';
import type { PaceColor } from '../../utils/planUsagePace';

interface PlanUsageBalanceProps {
  amount: string;
  color: PaceColor;
  tooltip: string;
  t: TFunction;
}

/**
 * Prepaid balance vendors (DeepSeek/Moonshot/OpenRouter/…): no percentage
 * denominator, so the labeled amount renders instead of the bar.
 */
export const PlanUsageBalance = ({
  amount,
  color,
  tooltip,
  t,
}: PlanUsageBalanceProps) => (
  <div
    className={`plan-usage pace-${color} has-tooltip`}
    data-tooltip={tooltip}
    aria-label={tooltip}
  >
    <span className="plan-usage-balance">
      {t('chat.planUsage.balanceLabel', { defaultValue: 'Balance: ' })}
      {amount}
    </span>
  </div>
);
