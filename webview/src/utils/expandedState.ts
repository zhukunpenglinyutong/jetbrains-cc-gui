const expandedState = new Map<string, boolean>();

export function getPersistedExpanded(key: string): boolean {
  return expandedState.get(key) ?? false;
}

export function setPersistedExpanded(key: string, value: boolean): void {
  expandedState.set(key, value);
}

export function clearAllPersistedExpanded(): void {
  expandedState.clear();
}
