/**
 * Per-provider visibility for the runtime CLI switcher (ProviderSelect / BlinkingLogo).
 *
 * Hidden providers are omitted from the switcher dropdown but remain fully
 * functional — a hidden active provider still displays in the trigger button.
 * Storage: localStorage (same pattern as betaProviderNotice).
 */

export const CLI_PROVIDER_VISIBILITY_KEY = 'cli-provider-hidden-ids';

/** Same-tab change notification; the `storage` event only fires across tabs. */
const CLI_PROVIDER_VISIBILITY_EVENT = 'cli-provider-visibility-changed';

/**
 * Read the hidden provider id list.
 * Defaults to [] so all providers show until the user hides one.
 */
export function getHiddenCliProviderIds(): string[] {
  try {
    const raw = localStorage.getItem(CLI_PROVIDER_VISIBILITY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    // localStorage can throw in sandboxed contexts; treat as nothing hidden.
    return [];
  }
}

/**
 * Persist a provider's visibility and notify same-tab subscribers.
 * Silent no-op on storage failure.
 */
export function setCliProviderHidden(providerId: string, hidden: boolean): void {
  try {
    const ids = new Set(getHiddenCliProviderIds());
    if (hidden) {
      ids.add(providerId);
    } else {
      ids.delete(providerId);
    }
    localStorage.setItem(CLI_PROVIDER_VISIBILITY_KEY, JSON.stringify([...ids]));
  } catch (error) {
    console.warn('[cliProviderVisibility] failed to persist:', error);
    return;
  }
  window.dispatchEvent(new Event(CLI_PROVIDER_VISIBILITY_EVENT));
}

/**
 * Subscribe to visibility changes (same tab via custom event, cross-tab via storage).
 */
export function subscribeCliProviderVisibility(listener: () => void): () => void {
  window.addEventListener(CLI_PROVIDER_VISIBILITY_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CLI_PROVIDER_VISIBILITY_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}
