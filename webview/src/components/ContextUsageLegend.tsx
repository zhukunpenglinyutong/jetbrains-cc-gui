import { useTranslation } from 'react-i18next';
import type { ContextUsageData } from './ContextUsageDialog';
import { resolveColor, formatTokens } from './contextUsageUtils';

type Category = ContextUsageData['categories'][number];

interface ContextUsageLegendProps {
  visibleCategories: ContextUsageData['categories'];
  autoCompactBuffer?: Category;
  freeSpace?: Category;
  translateCategoryName: (name: string) => string;
}

export function ContextUsageLegend({
  visibleCategories,
  autoCompactBuffer,
  freeSpace,
  translateCategoryName,
}: ContextUsageLegendProps) {
  const { t } = useTranslation();

  return (
    <div className="context-usage-legend">
      {visibleCategories.map((cat) => {
        const translatedName = translateCategoryName(cat.name);
        return (
        <div key={`${cat.name}-${cat.color}`} className="context-usage-legend-item" title={`${translatedName}: ${formatTokens(cat.tokens)}`}>
          <span
            className="context-usage-legend-dot"
            style={{ backgroundColor: resolveColor(cat.color) }}
          />
          <span className="context-usage-legend-name">{translatedName}</span>
          <span className="context-usage-legend-tokens">
            {cat.isDeferred
              ? t('contextUsage.notAvailable', { defaultValue: 'N/A' })
              : formatTokens(cat.tokens)}
          </span>
        </div>
        );
      })}
      {autoCompactBuffer && autoCompactBuffer.tokens > 0 && (
        <div
          className="context-usage-legend-item"
          title={`${t('contextUsage.categories.autoCompactBuffer', { defaultValue: 'Autocompact buffer' })}: ${formatTokens(autoCompactBuffer.tokens)}`}
        >
          <span
            className="context-usage-legend-dot"
            style={{ backgroundColor: resolveColor(autoCompactBuffer.color), opacity: 0.5 }}
          />
          <span className="context-usage-legend-name">
            {t('contextUsage.categories.autoCompactBuffer', { defaultValue: 'Autocompact buffer' })}
          </span>
          <span className="context-usage-legend-tokens">{formatTokens(autoCompactBuffer.tokens)}</span>
        </div>
      )}
      {freeSpace && freeSpace.tokens > 0 && (
        <div
          className="context-usage-legend-item free-space-legend"
          title={`${t('contextUsage.categories.freeSpace', { defaultValue: 'Free space' })}: ${formatTokens(freeSpace.tokens)}`}
        >
          <span className="context-usage-legend-dot free-space-dot" />
          <span className="context-usage-legend-name">
            {t('contextUsage.categories.freeSpace', { defaultValue: 'Free space' })}
          </span>
          <span className="context-usage-legend-tokens">{formatTokens(freeSpace.tokens)}</span>
        </div>
      )}
    </div>
  );
}
