import { useTranslation } from 'react-i18next';
import type { DailyUsage } from '../../types/usage';

function getGridLineStyle(index: number): React.CSSProperties {
  return { bottom: `${index * 25}%` };
}

function getBarStyle(height: number): React.CSSProperties {
  return { height: `${height}%` };
}

function getTooltipStyle(x: number, y: number): React.CSSProperties {
  return { left: x, top: y };
}

interface TimelineTabProps {
  filteredDailyUsage: DailyUsage[];
  tooltip: {
    visible: boolean;
    x: number;
    y: number;
    content: { date: string; cost: number; sessions: number };
  };
  setTooltip: React.Dispatch<React.SetStateAction<TimelineTabProps['tooltip']>>;
  formatCost: (cost: number) => string;
  formatChineseDate: (dateStr: string) => string;
}

export const UsageTimelineTab = ({
  filteredDailyUsage, tooltip, setTooltip,
  formatCost, formatChineseDate,
}: TimelineTabProps) => {
  const { t } = useTranslation();

  return (
    <div className="timeline-tab">
      <h4>{t('usage.dailyTrend')}</h4>
      <div className="timeline-chart">
        {filteredDailyUsage.length > 0 ? (
          (() => {
            const maxCost = Math.max(...filteredDailyUsage.map(d => d.cost));
            const yAxisValues = [0, maxCost * 0.25, maxCost * 0.5, maxCost * 0.75, maxCost];

            return (
              <div className="chart-with-axis">
                <div className="chart-y-axis">
                  {[...yAxisValues].reverse().map((val, i) => (
                    <div key={i} className="y-axis-label">
                      {formatCost(val)}
                    </div>
                  ))}
                </div>

                <div className="chart-main">
                  <div className="chart-grid">
                    {[0, 1, 2, 3, 4].map(i => (
                      <div key={i} className="chart-grid-line" style={getGridLineStyle(i)} />
                    ))}
                  </div>

                  <div className="chart-scroll-view">
                    <div className="chart-bars">
                      {filteredDailyUsage.map((day) => {
                        const height = maxCost > 0 ? (day.cost / maxCost) * 100 : 0;
                        return (
                          <div key={day.date} className="chart-bar-wrapper">
                            <div className="chart-bar-container">
                              <div
                                className="chart-bar"
                                style={getBarStyle(height)}
                                onMouseEnter={(e) => {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  setTooltip({
                                    visible: true,
                                    x: rect.left + rect.width / 2,
                                    y: rect.top,
                                    content: { date: day.date, cost: day.cost, sessions: day.sessions }
                                  });
                                }}
                                onMouseLeave={() => setTooltip(prev => ({ ...prev, visible: false }))}
                              />
                            </div>
                            <div className="chart-label">{formatChineseDate(day.date)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()
        ) : (
          <div className="empty-timeline">
            <span className="codicon codicon-info" />
            <p>{t('usage.noDataInRange')}</p>
          </div>
        )}
      </div>

      {tooltip.visible && (
        <div
          className="chart-tooltip"
          style={getTooltipStyle(tooltip.x, tooltip.y)}
        >
          <div className="tooltip-date">{formatChineseDate(tooltip.content.date)}</div>
          <div className="tooltip-cost">{formatCost(tooltip.content.cost)}</div>
          <div className="tooltip-sessions">{tooltip.content.sessions} {t('usage.sessionsCount')}</div>
        </div>
      )}
    </div>
  );
};
