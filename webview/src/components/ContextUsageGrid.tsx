import { clampUsagePercentage } from '../utils/usagePercentage';
import type { ContextUsageData } from './ContextUsageDialog';
import { resolveColor, formatTokens } from './contextUsageUtils';

type GridSquare = ContextUsageData['gridRows'][number][number];

interface GridCellProps {
  square: GridSquare;
  translateCategoryName: (name: string) => string;
}

function GridCell({ square: sq, translateCategoryName }: GridCellProps) {
  if (sq.categoryName === 'Free space') {
    return (
      <div
        className="context-usage-grid-cell free-space"
        title={`${translateCategoryName(sq.categoryName)}: ${formatTokens(sq.tokens)}`}
      />
    );
  }
  if (sq.categoryName === 'Autocompact buffer') {
    return (
      <div
        className="context-usage-grid-cell"
        style={{ backgroundColor: resolveColor(sq.color), opacity: 0.5 }}
        title={`${translateCategoryName(sq.categoryName)}: ${formatTokens(sq.tokens)}`}
      />
    );
  }
  const safeFullness = Number.isFinite(sq.squareFullness)
    ? Math.max(0, Math.min(1, sq.squareFullness))
    : 0;
  const filled = safeFullness >= 0.7;
  return (
    <div
      className={`context-usage-grid-cell ${filled ? 'filled' : 'partial'}`}
      style={{
        backgroundColor: resolveColor(sq.color),
        ...(filled ? {} : { opacity: 0.5 + safeFullness * 0.5 }),
      }}
      title={`${translateCategoryName(sq.categoryName)}: ${formatTokens(sq.tokens)} (${clampUsagePercentage(sq.percentage).toFixed(1)}%)`}
    />
  );
}

interface ContextUsageGridProps {
  gridRows: ContextUsageData['gridRows'];
  translateCategoryName: (name: string) => string;
}

export function ContextUsageGrid({ gridRows, translateCategoryName }: ContextUsageGridProps) {
  if (!gridRows || gridRows.length === 0) {
    return null;
  }

  return (
    <div className="context-usage-grid">
      {gridRows.map((row, ri) => (
        <div key={`row-${ri}`} className="context-usage-grid-row">
          {row.map((sq, ci) => (
            <GridCell
              key={`${sq.categoryName}-${ri}-${ci}`}
              square={sq}
              translateCategoryName={translateCategoryName}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
