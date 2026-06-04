import type { ClaudeMessage } from '../types';

/**
 * Per-message token usage extracted from raw message data.
 */
export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * - Under 1 minute: "M:SS"
 * - Over 1 hour: "H:MM:SS"
 */
export function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

/**
 * Format token count with locale-specific thousand separators.
 * Example: 1234 → "1,234"
 */
export function formatTokenCount(count: number): string {
  return count.toLocaleString();
}

/**
 * Extract per-message token usage from the raw message data.
 *
 * The SDK sends usage data inside the raw JSON:
 * - Path 1: raw.message.usage.input_tokens / output_tokens  (standard SDK format)
 * - Path 2: raw.usage.input_tokens / output_tokens           (flat format fallback)
 *
 * Returns null if no meaningful usage data is found.
 */
export function extractMessageUsage(message: ClaudeMessage): MessageUsage | null {
  const raw = message.raw;
  if (!raw || typeof raw !== 'object') return null;

  const rawObj = raw as Record<string, unknown>;

  // Try raw.message.usage first (standard SDK format)
  let usage: Record<string, unknown> | null = null;
  const messageField = rawObj.message;
  if (messageField && typeof messageField === 'object') {
    const msgObj = messageField as Record<string, unknown>;
    if (msgObj.usage && typeof msgObj.usage === 'object') {
      usage = msgObj.usage as Record<string, unknown>;
    }
  }

  // Fallback: raw.usage (flat format)
  if (!usage && rawObj.usage && typeof rawObj.usage === 'object') {
    usage = rawObj.usage as Record<string, unknown>;
  }

  if (!usage) return null;

  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

  // Only return if at least one has a positive value
  if (inputTokens <= 0 && outputTokens <= 0) return null;

  return { inputTokens, outputTokens };
}
