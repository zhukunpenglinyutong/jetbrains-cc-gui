export const DEFAULT_GEMINI_IDLE_REAP_MINUTES = 30;
export const MIN_GEMINI_IDLE_REAP_MINUTES = 0;
// One full day of allowed silence. Above that a watchdog is indistinguishable
// from disabled, and an uncapped field lets values > 2^31-1 through — which
// the Java side narrows via Gson getAsInt() and can read as negative (→
// clamped 0 = silently disabled). 1440 keeps every accepted value far inside
// int range while still admitting any plausible "it runs for hours" window.
export const MAX_GEMINI_IDLE_REAP_MINUTES = 1440;

/**
 * Normalizes the idle-reap input draft to a committable whole-minute value.
 *
 * Unlike the permission-dialog precedent (which maps invalid input to its
 * default), a blank or non-numeric draft yields null = "no change": the card
 * restores the previous authoritative value and sends nothing. Silently
 * flipping a disabled watchdog (0) back to the enabled default on an
 * abandoned edit would be a kill-direction regression; Escape/blank must
 * revert, not commit.
 *
 * Numeric input is truncated and clamped into [0, 1440]: negatives disable
 * (matching the Java setter's normalization), anything above the max clamps
 * to it (see MAX above for why the cap exists).
 *
 * @returns the clamped minutes, or null when the draft carries no commitable
 *   value (blank / non-numeric / non-finite).
 */
export function clampGeminiIdleReapMinutes(raw: unknown): number | null {
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(
    MIN_GEMINI_IDLE_REAP_MINUTES,
    Math.min(MAX_GEMINI_IDLE_REAP_MINUTES, Math.trunc(parsed)),
  );
}
