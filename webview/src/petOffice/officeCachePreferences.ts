export const OFFICE_MIB = 1024 * 1024;
export const OFFICE_CACHE_DEFAULT_MIB = 50;
export const OFFICE_CACHE_MIN_MIB = 16;
export const OFFICE_CACHE_MAX_MIB = 256;
const PREFERENCE_KEY = 'ccgui.pet.office.cache.v1';
type CacheStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface OfficeCachePreferences { limitMiB: number; error: boolean }

export function validOfficeCacheLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= OFFICE_CACHE_MIN_MIB && value <= OFFICE_CACHE_MAX_MIB;
}

/** Aggregate retained/reserved pixels; individual input and native-decode guards remain separate. */
export function resolveOfficeCacheBudget(bytes?: number): number {
  return bytes !== undefined && validOfficeCacheLimit(bytes / OFFICE_MIB) ? bytes : OFFICE_CACHE_DEFAULT_MIB * OFFICE_MIB;
}

export function officeBackgroundAllowance(budget: number): number { return Math.min(16 * OFFICE_MIB, Math.floor(budget / 2)); }

export function readOfficeCachePreferences(storage?: CacheStorage): OfficeCachePreferences {
  try {
    const text = (storage ?? window.localStorage).getItem(PREFERENCE_KEY);
    if (text === null) return { limitMiB: OFFICE_CACHE_DEFAULT_MIB, error: false };
    if (text.length > 128) throw new Error('Invalid cache preferences');
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1
      || !('limitMiB' in value) || !validOfficeCacheLimit(value.limitMiB) || Object.keys(value).length !== 2) throw new Error('Invalid cache preferences');
    return { limitMiB: value.limitMiB, error: false };
  } catch { return { limitMiB: OFFICE_CACHE_DEFAULT_MIB, error: true }; }
}

export function writeOfficeCachePreferences(limitMiB: number, storage?: CacheStorage): boolean {
  if (!validOfficeCacheLimit(limitMiB)) return false;
  try { (storage ?? window.localStorage).setItem(PREFERENCE_KEY, JSON.stringify({ schemaVersion: 1, limitMiB })); return true; }
  catch { return false; }
}
