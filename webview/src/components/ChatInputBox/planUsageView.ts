import type { TFunction } from 'i18next';
import {
  clampPercent,
  formatBalance,
  formatFullReset,
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
  const fullReset = present ? formatFullReset(display!.resetAt, language) : '';
  const winLabel = windowShortLabel(display?.windowId || display?.periodType);
  const balance = snapshot?.balance;
  const balanceView: PlanUsageBalanceView | null =
    balance && (snapshot?.windows ?? []).length === 0
      ? {
        amount: formatBalance(balance.remaining, balance.unit),
        color: (balance.remaining <= 0 ? 'red' : 'neutral') as PaceColor,
      }
      : null;
  return { present, tp, color, worstColor, fullReset, winLabel, balance: balanceView };
}

/** Use the same percentage in the summary and details, including tiny usage. */
export function formatPlanUsagePercent(value: number): string {
  const pct = clampPercent(value);
  const rounded = Math.round(pct);
  return pct > 0 && rounded === 0 ? '<1%' : `${rounded}%`;
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
  language: string;
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
  language,
  t,
}: PlanUsageTooltipArgs): string {
  if (!present) {
    return snapshot?.message
      || t('chat.planUsage.unavailable', { defaultValue: 'Usage unavailable' });
  }
  const period = display?.periodType || display?.windowId || 'limit';
  const lines = [t('chat.planUsage.title', { defaultValue: 'Claude plan usage' })];
  if (snapshot?.level) {
    lines.push(snapshot.level.toUpperCase());
  }
  const appendWindow = (windowPeriod: string, usedPct: number, reset: string) => {
    lines.push(
      t('chat.planUsage.tooltipWindow', {
        period: windowPeriod,
        percent: formatPlanUsagePercent(usedPct),
        defaultValue: '{{period}} · {{percent}} used',
      }),
    );
    if (reset) {
      lines.push(t('chat.planUsage.tooltipReset', {
        value: reset,
        defaultValue: 'Resets: {{value}} (local time)',
      }));
    }
  };
  appendWindow(period, tp, fullReset);
  if (windows.length > 1) {
    for (const window of windows) {
      if (window.id === display?.windowId) continue;
      lines.push('');
      appendWindow(window.id, window.usedPct, formatFullReset(window.resetAt, language));
    }
    if (worstColor !== color && worstColor !== 'neutral' && worstColor !== 'green') {
      lines.push(
        t('chat.planUsage.worstHint', {
          color: t(`chat.planUsage.paceColors.${worstColor}`, { defaultValue: worstColor }),
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
