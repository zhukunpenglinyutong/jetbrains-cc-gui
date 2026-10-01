export const DEFAULT_HISTORY_LOAD_TIMEOUT_SECONDS = 10;
export const MIN_HISTORY_LOAD_TIMEOUT_SECONDS = 5;
export const MAX_HISTORY_LOAD_TIMEOUT_SECONDS = 120;

export function clampHistoryLoadTimeoutSeconds(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_HISTORY_LOAD_TIMEOUT_SECONDS;
  return Math.max(MIN_HISTORY_LOAD_TIMEOUT_SECONDS, Math.min(MAX_HISTORY_LOAD_TIMEOUT_SECONDS, parsed));
}
