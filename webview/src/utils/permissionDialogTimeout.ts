export const DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS = 300;
export const MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS = 30;
export const MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS = 3600;

/**
 * Normalizes a permission dialog timeout value to a supported whole-second range.
 * Invalid values fall back to the default timeout.
 */
export function clampPermissionDialogTimeoutSeconds(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
  }

  return Math.max(
    MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS,
    Math.min(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS, Math.trunc(parsed)),
  );
}
