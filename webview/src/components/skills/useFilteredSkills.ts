import { useMemo } from 'react';
import type { Skill, SkillsConfig, SkillFilter, SkillEnabledFilter } from '../../types/skill';

/**
 * Derives provider-aware skill lists, applies scope/enabled/search filters,
 * sorts enabled-first, and computes tab counts.
 */
export function useFilteredSkills(
  skills: SkillsConfig,
  isCodex: boolean,
  currentFilter: SkillFilter,
  enabledFilter: SkillEnabledFilter,
  searchQuery: string
) {
  // Compute Skills lists (provider-aware: Claude uses global/local, Codex uses user/repo)
  const primarySkillList = useMemo(
    () => Object.values(isCodex ? (skills.user ?? {}) : skills.global),
    [isCodex, skills.global, skills.user]
  );
  const secondarySkillList = useMemo(
    () => Object.values(isCodex ? (skills.repo ?? {}) : skills.local),
    [isCodex, skills.local, skills.repo]
  );
  const allSkillList = useMemo(() => [...primarySkillList, ...secondarySkillList], [primarySkillList, secondarySkillList]);

  // Filtered Skills list
  const filteredSkills = useMemo(() => {
    let list: Skill[] = [];
    if (currentFilter === 'all') {
      list = allSkillList;
    } else if (currentFilter === 'global' || currentFilter === 'user') {
      list = primarySkillList;
    } else {
      list = secondarySkillList;
    }

    // Filter by enabled status
    if (enabledFilter === 'enabled') {
      list = list.filter(s => s.enabled);
    } else if (enabledFilter === 'disabled') {
      list = list.filter(s => !s.enabled);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(query) ||
        s.path.toLowerCase().includes(query) ||
        (s.description && s.description.toLowerCase().includes(query))
      );
    }

    // Sort by enabled status: enabled first
    return [...list].sort((a, b) => {
      if (a.enabled === b.enabled) return 0;
      return a.enabled ? -1 : 1;
    });
  }, [currentFilter, enabledFilter, searchQuery, allSkillList, primarySkillList, secondarySkillList]);

  // Counts
  const totalCount = allSkillList.length;
  const primaryCount = primarySkillList.length;
  const secondaryCount = secondarySkillList.length;
  const { enabledCount, disabledCount } = useMemo(() => {
    let enabled = 0;
    for (const s of allSkillList) if (s.enabled) enabled++;
    return { enabledCount: enabled, disabledCount: allSkillList.length - enabled };
  }, [allSkillList]);

  return {
    filteredSkills,
    totalCount,
    primaryCount,
    secondaryCount,
    enabledCount,
    disabledCount,
  };
}
