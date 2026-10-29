import React, { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  nextWindowId,
  readStoredWindowId,
  resolveDisplayWindow,
  writeStoredWindowId,
  type PlanUsageSnapshot,
} from '../../utils/planUsagePace';
import { PlanUsageLoading } from './PlanUsageLoading';
import { PlanUsageUnavailable } from './PlanUsageUnavailable';
import { PlanUsageBar } from './PlanUsageBar';
import { PlanUsageTooltip } from './PlanUsageTooltip';
import {
  buildBalanceTooltip,
  buildPlanUsageTooltip,
  derivePlanUsageView,
} from './planUsageView';

export interface PlanUsageIndicatorProps {
  snapshot: PlanUsageSnapshot | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
}

/**
 * Compact summary with full reset dates and known windows in a tooltip.
 * Click the window chip (5h / 7d) to cycle between windows.
 */
export const PlanUsageIndicator: React.FC<PlanUsageIndicatorProps> = memo(({
  snapshot,
  status,
}) => {
  const { t, i18n } = useTranslation();
  const [windowId, setWindowId] = useState<string | null>(() => readStoredWindowId());

  const display = useMemo(() => {
    if (!snapshot?.present) return null;
    return resolveDisplayWindow(snapshot, windowId);
  }, [snapshot, windowId]);

  const windows = useMemo(() => snapshot?.windows ?? [], [snapshot]);
  const canSwitch = windows.length > 1;

  const onCycleWindow = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canSwitch) return;
    const next = nextWindowId(windows, display?.windowId ?? windowId);
    if (!next) return;
    setWindowId(next);
    writeStoredWindowId(next);
  }, [canSwitch, windows, display?.windowId, windowId]);

  const { present, tp, color, worstColor, fullReset, winLabel, balance } =
    derivePlanUsageView(snapshot, display, i18n.language);

  const tooltip = useMemo(() => buildPlanUsageTooltip({
    present,
    snapshot,
    tp,
    fullReset,
    display,
    windows,
    worstColor,
    color,
    language: i18n.language,
    t,
  }), [present, snapshot, tp, fullReset, display, windows, worstColor, color, i18n.language, t]);

  const balanceTooltip = useMemo(
    () => (balance ? buildBalanceTooltip(snapshot, balance.amount, t) : ''),
    [balance, snapshot, t],
  );

  if (status === 'idle') return null;

  if (!present && status === 'loading') {
    return <PlanUsageLoading t={t} />;
  }

  if (!present) {
    return <PlanUsageUnavailable tooltip={tooltip} t={t} />;
  }

  // Prepaid balance vendors (DeepSeek/Moonshot/OpenRouter/…): no percentage
  // denominator, so show the labeled amount instead of the bar. Reaching here
  // relies on resolveDisplayWindow's fallback returning capacityPct 0 for
  // balance-only snapshots — that keeps `present` true past the check above.
  if (balance) {
    return (
      <PlanUsageTooltip
        className={`plan-usage pace-${balance.color}`}
        tooltip={balanceTooltip}
      >
        <span className="plan-usage-balance">
          {t('chat.planUsage.balanceLabel', { defaultValue: 'Balance: ' })}
          {balance.amount}
        </span>
      </PlanUsageTooltip>
    );
  }

  return (
    <PlanUsageBar
      tooltip={tooltip}
      color={color}
      tp={tp}
      canSwitch={canSwitch}
      winLabel={winLabel}
      onCycleWindow={onCycleWindow}
      worstColor={worstColor}
      t={t}
    />
  );
});

PlanUsageIndicator.displayName = 'PlanUsageIndicator';
