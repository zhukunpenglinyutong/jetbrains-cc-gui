export const EDIT_GROUP_COLLAPSED_KEY = 'editGroupCollapsedByDefault';
const EDIT_GROUP_COLLAPSED_EVENT = 'edit-group-collapsed-changed';

export function getEditGroupCollapsedByDefault(): boolean {
  try {
    return localStorage.getItem(EDIT_GROUP_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setEditGroupCollapsedByDefault(collapsed: boolean): void {
  try {
    if (collapsed) {
      localStorage.setItem(EDIT_GROUP_COLLAPSED_KEY, 'true');
    } else {
      localStorage.removeItem(EDIT_GROUP_COLLAPSED_KEY);
    }
  } catch (error) {
    console.warn('[editGroupCollapsePreference] failed to persist:', error);
    return;
  }

  window.dispatchEvent(new Event(EDIT_GROUP_COLLAPSED_EVENT));
}

export function subscribeEditGroupCollapsePreference(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === EDIT_GROUP_COLLAPSED_KEY || event.key === null) {
      onChange();
    }
  };

  window.addEventListener(EDIT_GROUP_COLLAPSED_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EDIT_GROUP_COLLAPSED_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}
