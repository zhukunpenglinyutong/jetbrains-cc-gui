export const BASH_GROUP_COLLAPSED_KEY = 'bashGroupCollapsedByDefault';
const BASH_GROUP_COLLAPSED_EVENT = 'bash-group-collapsed-changed';

export function getBashGroupCollapsedByDefault(): boolean {
  try {
    return localStorage.getItem(BASH_GROUP_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setBashGroupCollapsedByDefault(collapsed: boolean): void {
  try {
    if (collapsed) {
      localStorage.setItem(BASH_GROUP_COLLAPSED_KEY, 'true');
    } else {
      localStorage.removeItem(BASH_GROUP_COLLAPSED_KEY);
    }
  } catch (error) {
    console.warn('[bashGroupCollapsePreference] failed to persist:', error);
    return;
  }

  window.dispatchEvent(new Event(BASH_GROUP_COLLAPSED_EVENT));
}

export function subscribeBashGroupCollapsePreference(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === BASH_GROUP_COLLAPSED_KEY || event.key === null) {
      onChange();
    }
  };

  window.addEventListener(BASH_GROUP_COLLAPSED_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(BASH_GROUP_COLLAPSED_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}
