import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage } from '../../types';

function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

interface TokenUsageInfo {
  /** Total input-side tokens for the turn (non-cache input + cache write + cache read). */
  inputTokens: number;
  outputTokens: number;
  nonCacheInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Reasoning tokens reported by the backend, when it reports them at all. */
  thinkingTokens: number;
  costUsd?: number;
}

/**
 * Extract whole-turn token usage from a message's raw JSON.
 *
 * Reads the `turnUsage` field stamped by the backend when a turn completes
 * (ClaudeMessageHandler.handleResult / CodexMessageHandler.handleResultMessage).
 * It aggregates every API call in the turn, normalized to the Claude usage
 * schema (input_tokens excludes cache; cache fields are separate).
 *
 * Do NOT read `raw.message.usage` or `raw.usage` here: those carry per-API-call
 * and session-cumulative values that feed the context-usage status bar, and
 * would understate (Claude) or overstate (Codex) what this turn consumed.
 *
 * Returns null when no turn usage is available (aborted turns, history replay).
 */
function extractTokenUsage(raw: ClaudeMessage['raw']): TokenUsageInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const usageSrc = (raw as Record<string, unknown>).turnUsage;
  if (!usageSrc || typeof usageSrc !== 'object') return null;
  const usage = usageSrc as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const nonCacheInput = num(usage.input_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const thinking = num(usage.thinking_tokens);
  const output = num(usage.output_tokens);
  const input = nonCacheInput + cacheCreation + cacheRead;
  if (input === 0 && output === 0) return null;
  const rawCost = (raw as Record<string, unknown>).turnCostUsd;
  const costUsd = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost > 0 ? rawCost : undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    nonCacheInputTokens: nonCacheInput,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    thinkingTokens: thinking,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** Format a token count for compact display (e.g., 1234 → "1.2K"). */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatUsdCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return '<$0.0001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function formatCacheHitRatio(tokenInfo: TokenUsageInfo): string | null {
  if (tokenInfo.cacheReadTokens <= 0 || tokenInfo.inputTokens <= 0) return null;
  const ratio = Math.round((tokenInfo.cacheReadTokens / tokenInfo.inputTokens) * 100);
  return `${Math.min(100, Math.max(0, ratio))}%`;
}

interface MessageDurationFooterProps {
  message: ClaudeMessage;
  isMessageStreaming: boolean;
  detailedOutputEnabled: boolean;
  t: TFunction;
}

/** Duration and token display after last assistant message */
export const MessageDurationFooter = memo(function MessageDurationFooter({
  message,
  isMessageStreaming,
  detailedOutputEnabled,
  t,
}: MessageDurationFooterProps) {
  if (message.type !== 'assistant' || isMessageStreaming || typeof message.durationMs !== 'number') {
    return null;
  }

  const tokenInfo = extractTokenUsage(message.raw);
  const cacheHitRatio = detailedOutputEnabled && tokenInfo ? formatCacheHitRatio(tokenInfo) : null;
  const cacheHitLabel = tokenInfo && cacheHitRatio
    ? t('chat.cacheHitsWithRatio', {
      tokens: formatTokenCount(tokenInfo.cacheReadTokens),
      ratio: cacheHitRatio,
    })
    : '';
  const usageDetail = tokenInfo
    ? t('chat.tokenUsageDetail', {
      input: formatTokenCount(tokenInfo.nonCacheInputTokens),
      cacheWrite: formatTokenCount(tokenInfo.cacheCreationTokens),
      cacheRead: formatTokenCount(tokenInfo.cacheReadTokens),
      output: formatTokenCount(tokenInfo.outputTokens),
    })
    : '';
  // Thinking is shown only when the backend actually reported it;
  // it never inflates the input figure (not context input).
  const usageDetailTitle = tokenInfo && tokenInfo.thinkingTokens > 0
    ? `${usageDetail} · ${t('chat.tokenUsageThinking', {
      thinking: formatTokenCount(tokenInfo.thinkingTokens),
    })}`
    : usageDetail;

  return (
    <div className="message-duration">
      <span className="message-duration-inner">
        <span className="message-duration-flag codicon codicon-clock"></span>
        <span className="message-duration-cost">{t('chat.totalDuration')}</span>
        <span className="message-duration-value">{formatDurationMs(message.durationMs)}</span>
        {tokenInfo && (
          <>
            <span className="message-duration-separator">·</span>
            <span
              className="message-duration-tokens"
              title={usageDetailTitle}
            >
              {t('chat.tokenUsage', {
                input: `${formatTokenCount(tokenInfo.inputTokens)}${cacheHitLabel}`,
                output: formatTokenCount(tokenInfo.outputTokens),
              })}
            </span>
            {detailedOutputEnabled && tokenInfo.costUsd !== undefined && (
              <>
                <span className="message-duration-separator">·</span>
                <span className="message-duration-tokens">{formatUsdCost(tokenInfo.costUsd)}</span>
              </>
            )}
          </>
        )}
      </span>
    </div>
  );
});
