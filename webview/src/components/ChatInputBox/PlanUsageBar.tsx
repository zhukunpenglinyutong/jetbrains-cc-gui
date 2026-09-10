import type { MouseEvent } from 'react';
import type { TFunction } from 'i18next';
import type { PaceColor } from '../../utils/planUsagePace';

interface PlanUsageBarProps {
  tooltip: string;
  color: PaceColor;
  tp: number;
  canSwitch: boolean;
  winLabel: string;
  onCycleWindow: (e: MouseEvent) => void;
  shortReset: string;
  worstColor: PaceColor;
  t: TFunction;
}

/** Present view: mini progress bar + % + window switcher + short reset + worst dot. */
export const PlanUsageBar = ({
  tooltip,
  color,
  tp,
  canSwitch,
  winLabel,
  onCycleWindow,
  shortReset,
  worstColor,
  t,
}: PlanUsageBarProps) => {
  const fillWidth = `${tp}%`;
  const rounded = Math.round(tp);
  const labelPct = tp > 0 && rounded === 0 ? '<1%' : `${rounded}%`;

  return (
    <div
      className={`plan-usage pace-${color} has-tooltip`}
      data-tooltip={tooltip}
      aria-label={tooltip}
    >
      <div className="plan-usage-bar" aria-hidden>
        <div className="plan-usage-fill" style={{ width: fillWidth }} />
      </div>
      <span className="plan-usage-pct">{labelPct}</span>
      {canSwitch || winLabel !== '·' ? (
        <button
          type="button"
          className={`plan-usage-window${canSwitch ? ' switchable' : ''}`}
          onClick={onCycleWindow}
          disabled={!canSwitch}
          title={
            canSwitch
              ? t('chat.planUsage.clickToSwitch', {
                defaultValue: 'Click to switch between windows',
              })
              : undefined
          }
        >
          {winLabel}
        </button>
      ) : null}
      {shortReset ? (
        <span className="plan-usage-reset">{shortReset}</span>
      ) : null}
      {/* Worst pace across all windows — after reset date */}
      <span
        className={`plan-usage-worst-dot pace-${worstColor}`}
        aria-hidden
        title={
          worstColor !== 'neutral'
            ? t('chat.planUsage.worstDot', {
              color: worstColor,
              defaultValue: 'Worst window: {{color}}',
            })
            : undefined
        }
      />
    </div>
  );
};
