import { useState, useSyncExternalStore } from 'react';
import type { CollapsePreference } from '../utils/collapsePreference';

/**
 * Expanded state that follows the given collapse preference until the user
 * explicitly toggles this instance; a manual toggle sticks for its lifetime.
 */
export function usePreferredExpanded(preference: CollapsePreference) {
  const collapsedByDefault = useSyncExternalStore(preference.subscribe, preference.get);
  const [expandedOverride, setExpandedOverride] = useState<boolean>();
  const expanded = expandedOverride ?? !collapsedByDefault;
  const toggleExpanded = () => {
    setExpandedOverride(previous => !(previous ?? !collapsedByDefault));
  };
  return { expanded, toggleExpanded };
}
