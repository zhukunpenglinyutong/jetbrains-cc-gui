import type { TFunction } from 'i18next';
import {
  clampPercent,
  formatBalance,
  formatFullReset,
  formatShortReset,
  paceColor,
  resolveTimeBudget,
  windowShortLabel,
  worstPaceColor,
  type CapacityWindow,
  type PaceColor,
  type PlanUsageSnapshot,
} from '../../utils/planUsagePace';

/** Window resolved for display (selected window or binding top-level). */
export interface PlanUsageDisplay {
  windowId: string | null;
  capacityPct: number;
  resetAt: string | null | undefined;
  periodType: string | null | undefined;
}

export interface PlanUsageBalanceView {
  /** Formatted remaining amount, e.g. "¥42.50". */
  amount: string;
  /** Red when the balance is exhausted, neutral otherwise. */
  color: PaceColor;
}

export interface PlanUsageView {
  present: boolean;
  tp: number;
  color: PaceColor;
  worstColor: PaceColor;
  shortReset: string;
  fullReset: string;
  winLabel: string;
  /** Non-null only for prepaid balance vendors without pct windows. */
  balance: PlanUsageBalanceView | null;
}

/**
 * Derived view values for the indicator.
 * Bar/% = selected window; trailing dot = worst across all windows.
 * Prepaid balance vendors (DeepSeek/Moonshot/OpenRouter/…) have no
 * percentage denominator — when a balance exists and there are no windows,
 * the indicator renders the labeled amount instead of the bar.
 */
export function derivePlanUsageView(
  snapshot: PlanUsageSnapshot | null,
  display: PlanUsageDisplay | null,
  language: string,
): PlanUsageView {
  const present = !!display && typeof display.capacityPct === 'number' && !!snapshot?.present;
  const tp = present ? clampPercent(display!.capacityPct) : 0;
  const tt = present
    ? resolveTimeBudget({
      resetAt: display!.resetAt,
      periodStart: snapshot?.periodStart,
      periodType: display!.periodType,
    })
    : null;
  const color = present ? paceColor(tp, tt) : 'neutral';
  const worstColor = present && snapshot ? worstPaceColor(snapshot) : 'neutral';
  const shortReset = present ? formatShortReset(display!.resetAt, language) : '';
  const fullReset = present ? formatFullReset(display!.resetAt, language) : '';
  const winLabel = windowShortLabel(display?.windowId || display?.periodType);
  const balance = snapshot?.balance;
  const balanceView =
    balance && (snapshot?.windows ?? []).length === 0
      ? {
        amount: formatBalance(balance.remaining, balance.unit),
        color: (balance.remaining <= 0 ? 'red' : 'neutral') as PaceColor,
      }
      : null;
  return { present, tp, color, worstColor, shortReset, fullReset, winLabel, balance: balanceView };
}

export interface PlanUsageTooltipArgs {
  present: boolean;
  snapshot: PlanUsageSnapshot | null;
  tp: number;
  fullReset: string;
  display: PlanUsageDisplay | null;
  windows: CapacityWindow[];
  worstColor: PaceColor;
  color: PaceColor;
  t: TFunction;
}

/** Multi-line tooltip text for the indicator. */
export function buildPlanUsageTooltip({
  present,
  snapshot,
  tp,
  fullReset,
  display,
  windows,
  worstColor,
  color,
  t,
}: PlanUsageTooltipArgs): string {
  if (!present) {
    return snapshot?.message
      || t('chat.planUsage.unavailable', { defaultValue: 'Usage unavailable' });
  }
  const pct = Math.round(tp);
  const period = display?.periodType || display?.windowId || 'limit';
  const lines: string[] = [];
  if (snapshot?.level) {
    lines.push(snapshot.level.toUpperCase());
  }
  if (fullReset) {
    lines.push(
      t('chat.planUsage.tooltipWindowWithReset', {
        period,
        percent: pct,
        value: fullReset,
        defaultValue: '{{period}} {{percent}}% · Resets {{value}}',
      }),
    );
  } else {
    lines.push(
      t('chat.planUsage.tooltipWindow', {
        period,
        percent: pct,
        defaultValue: '{{period}} {{percent}}%',
      }),
    );
  }
  if (windows.length > 1) {
    const others = windows
      .map((w) => `${w.id} ${Math.round(w.usedPct)}%`)
      .join(' · ');
    lines.push(others);
    if (worstColor !== color && worstColor !== 'neutral' && worstColor !== 'green') {
      lines.push(
        t('chat.planUsage.worstHint', {
          color: worstColor,
          defaultValue: 'Dot shows worst window ({{color}})',
        }),
      );
    }
    lines.push(
      t('chat.planUsage.clickToSwitch', {
        defaultValue: 'Click period label to switch window',
      }),
    );
  }
  if (snapshot?.stale) {
    lines.push(
      t('chat.planUsage.stale', {
        defaultValue: 'Data may be outdated (refresh failed)',
      }),
    );
  }
  return lines.join('\n');
}

/** Multi-line tooltip text for the prepaid balance view. */
export function buildBalanceTooltip(
  snapshot: PlanUsageSnapshot | null,
  amount: string,
  t: TFunction,
): string {
  const balance = snapshot?.balance;
  const lines: string[] = [
    t('chat.planUsage.balanceRemaining', {
      value: amount,
      defaultValue: 'Balance: {{value}}',
    }),
  ];
  if (balance && (balance.total != null || balance.used != null)) {
    lines.push(
      t('chat.planUsage.balanceDetail', {
        total: balance.total != null ? formatBalance(balance.total, balance.unit) : '—',
        used: balance.used != null ? formatBalance(balance.used, balance.unit) : '—',
        defaultValue: 'Total {{total}} · Used {{used}}',
      }),
    );
  }
  if (snapshot?.stale) {
    lines.push(
      t('chat.planUsage.stale', {
        defaultValue: 'Data may be outdated (refresh failed)',
      }),
    );
  }
  return lines.join('\n');
}
