import { memo } from 'react';
import type { TFunction } from 'i18next';

import { formatDurationMs, formatTokenCount } from '../../utils/messageUsage';

interface MessageUsageStatsProps {
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  t: TFunction;
}

/**
 * Usage stats bar displayed after each completed assistant message.
 * Shows input tokens, output tokens, and elapsed duration,
 * separated by vertical dividers — matching the mockup design.
 *
 * When token data is unavailable (e.g. old messages or during streaming),
 * only the duration is shown.
 */
export const MessageUsageStats = memo(function MessageUsageStats({
  inputTokens,
  outputTokens,
  durationMs,
  t,
}: MessageUsageStatsProps) {
  const hasTokens = (inputTokens !== null && inputTokens > 0) || (outputTokens !== null && outputTokens > 0);
  const hasDuration = durationMs !== null && durationMs > 0;

  // Don't render if there's nothing to show
  if (!hasTokens && !hasDuration) return null;

  return (
    <div className="usage-stats">
      {hasTokens && inputTokens !== null && inputTokens > 0 && (
        <>
          <div className="usage-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>{t('chat.usageStats.input')}</span>
            <span className="usage-value">{formatTokenCount(inputTokens)} tokens</span>
          </div>
          <div className="usage-divider" />
        </>
      )}

      {hasTokens && outputTokens !== null && outputTokens > 0 && (
        <>
          <div className="usage-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>{t('chat.usageStats.output')}</span>
            <span className="usage-value">{formatTokenCount(outputTokens)} tokens</span>
          </div>
          <div className="usage-divider" />
        </>
      )}

      {hasDuration && (
        <div className="usage-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span>{t('chat.usageStats.duration')}</span>
          <span className="usage-value">{formatDurationMs(durationMs!)}</span>
        </div>
      )}
    </div>
  );
});
