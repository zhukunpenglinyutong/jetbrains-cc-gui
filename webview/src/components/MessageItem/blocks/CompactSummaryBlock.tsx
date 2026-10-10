import { useState, useCallback, memo } from 'react';
import type { TFunction } from 'i18next';
import MarkdownBlock from '../../MarkdownBlock';
import type { CompactSummaryMetadata } from '../../../types';

/** Format a token count for compact display (e.g., 524835 → "524.8K"). */
function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/**
 * Build the compaction-stats subtitle from compact_boundary metadata:
 * "manual · 524.8K → 14.6K · 110s". Returns null when no stats are present.
 */
function formatCompactionStats(meta: CompactSummaryMetadata, t: TFunction): string | null {
  const parts: string[] = [];
  if (meta.trigger) parts.push(meta.trigger === 'manual' || meta.trigger === 'auto'
    ? t(`chat.compactSummary.${meta.trigger}`) : meta.trigger);
  if (typeof meta.preTokens === 'number') {
    const tokens = typeof meta.postTokens === 'number'
      ? `${formatCompactTokens(meta.preTokens)} → ${formatCompactTokens(meta.postTokens)}`
      : formatCompactTokens(meta.preTokens);
    parts.push(tokens);
  }
  if (typeof meta.durationMs === 'number') parts.push(`${Math.round(meta.durationMs / 1000)}s`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface CompactSummaryBlockProps {
  block: {
    type: 'compact_summary';
    title: string;
    content: string;
    metadata?: CompactSummaryMetadata;
  };
  t: TFunction;
}

/**
 * Compact summary block - collapsed by default, click/Enter/Space to expand.
 * Memoized to prevent state reset on parent re-renders during streaming.
 * `block.title` is an i18n key resolved via t() at render time.
 */
export const CompactSummaryBlock = memo(function CompactSummaryBlock({ block, t }: CompactSummaryBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded(e => !e), []);
  const meta = block.metadata;
  const hasCountMeta = meta && typeof meta.messagesSummarized === 'number';
  const compactionStats = meta ? formatCompactionStats(meta, t) : null;
  const hasMeta = hasCountMeta || compactionStats;
  const titleText = t(block.title);
  const toggleLabel = expanded ? t('chat.compactSummary.collapse') : t('chat.compactSummary.expand');
  const hasSummary = Boolean(block.content.trim());
  const date = meta?.timestamp != null ? new Date(meta.timestamp) : null;
  const validDate = date && Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null;

  return (
    <div className={`compact-summary-block${meta?.native ? ' native-compaction-boundary' : ''}`}>
      <button
        type="button"
        className="compact-summary-title"
        aria-expanded={expanded}
        aria-label={`${titleText} — ${toggleLabel}`}
        onClick={toggleExpanded}
        disabled={!hasSummary}
      >
        <span className="compact-summary-icon" aria-hidden="true">●</span>
        <span className="compact-summary-title-text">{titleText}</span>
        {hasSummary && <span className="compact-summary-toggle" aria-hidden="true">{expanded ? '▼' : '▶'}</span>}
      </button>
      {meta?.native && <div className="compact-boundary-time">
        {validDate ? <time dateTime={validDate.toISOString()} title={validDate.toLocaleString()}>
          {validDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
          {meta.timestampSource === 'turn' ? ` · ${t('chat.compactSummary.turnTime')}` : ''}
          {meta.timestampSource === 'received' ? ` · ${t('chat.compactSummary.receivedTime')}` : ''}
        </time> : t('chat.compactSummary.timeUnknown')}
      </div>}
      {hasMeta && (
        <div className="compact-summary-metadata">
          {hasCountMeta && (
            <span className="compact-summary-meta-count">
              {t(
                meta.direction === 'from'
                  ? 'chat.compactSummary.messagesFrom'
                  : 'chat.compactSummary.messagesUpTo',
                { count: meta.messagesSummarized },
              )}
            </span>
          )}
          {compactionStats && (
            <span className="compact-summary-meta-count">{compactionStats}</span>
          )}
          {meta?.userContext && (
            <span className="compact-summary-meta-context">
              {t('chat.compactSummary.userContext', { context: meta.userContext })}
            </span>
          )}
        </div>
      )}
      {expanded && block.content && (
        <div className="compact-summary-content">
          <MarkdownBlock content={block.content} />
        </div>
      )}
    </div>
  );
});
