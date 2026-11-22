import type { TFunction } from 'i18next';
import {
  clampPercent,
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

export interface PlanUsageView {
  present: boolean;
  tp: number;
  color: PaceColor;
  worstColor: PaceColor;
  fullReset: string;
  winLabel: string;
}

/**
 * Derived view values for the indicator.
 * Bar/% = selected window; trailing dot = worst across all windows.
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
  return { present, tp, color, worstColor, fullReset, winLabel };
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
  const lines = [snapshot?.provider === 'grok'
    ? t('chat.planUsage.grokTitle', { defaultValue: 'Grok plan usage' })
    : t('chat.planUsage.title', { defaultValue: 'Claude plan usage' })];
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
    // Dormant: nothing failed, the Grok daemon simply is not running to ask.
    lines.push(snapshot.dormant
      ? t('chat.planUsage.staleIdle', {
        defaultValue: 'Last reading. It refreshes the next time you use Grok',
      })
      : t('chat.planUsage.stale', {
        defaultValue: 'Data may be outdated (refresh failed)',
      }));
  }
  return lines.join('\n');
}
