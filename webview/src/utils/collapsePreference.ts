export interface CollapsePreference {
  get: () => boolean;
  set: (collapsed: boolean) => void;
  subscribe: (onChange: () => void) => () => void;
}

/**
 * Create a localStorage-backed boolean preference that notifies subscribers
 * both in this tab (custom event) and across tabs (storage event).
 */
export function createCollapsePreference(key: string, eventName: string): CollapsePreference {
  function get(): boolean {
    try {
      return localStorage.getItem(key) === 'true';
    } catch {
      return false;
    }
  }

  function set(collapsed: boolean): void {
    try {
      if (collapsed) {
        localStorage.setItem(key, 'true');
      } else {
        localStorage.removeItem(key);
      }
    } catch (error) {
      console.warn(`[collapsePreference] failed to persist "${key}":`, error);
      return;
    }

    window.dispatchEvent(new Event(eventName));
  }

  function subscribe(onChange: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        onChange();
      }
    };

    window.addEventListener(eventName, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(eventName, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }

  return { get, set, subscribe };
}
