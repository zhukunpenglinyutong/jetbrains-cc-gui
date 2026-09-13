/**
 * First-time Beta notice for experimental CLI providers (Grok / Kimi / OpenCode / PI).
 *
 * Shown once per machine when the user first clicks any beta provider entry.
 * Storage: localStorage (same pattern as skipNewSessionConfirm).
 */

export const BETA_PROVIDER_NOTICE_KEY = 'beta-cli-providers-notice-seen';

/**
 * Read whether the user has already acknowledged the beta notice.
 * Defaults to false so existing users see the dialog once after upgrade.
 */
export function hasSeenBetaProviderNotice(): boolean {
  try {
    return localStorage.getItem(BETA_PROVIDER_NOTICE_KEY) === 'true';
  } catch {
    // localStorage can throw in sandboxed contexts; treat as not seen (show dialog).
    return false;
  }
}

/**
 * Persist that the beta notice was acknowledged.
 * Silent no-op on storage failure so selection still proceeds.
 */
export function markBetaProviderNoticeSeen(): void {
  try {
    localStorage.setItem(BETA_PROVIDER_NOTICE_KEY, 'true');
  } catch (error) {
    console.warn('[betaProviderNotice] failed to persist:', error);
  }
}
