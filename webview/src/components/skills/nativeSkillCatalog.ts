import type { Skill, SkillsConfig } from '../../types/skill';

/** Keeps duplicate names distinct by their native file path. */
export function projectNativeSkills(rows: Record<string, unknown>[]): SkillsConfig {
  const config: SkillsConfig = { global: {}, local: {}, user: {}, repo: {} };
  for (const row of rows) {
    if (typeof row.name !== 'string' || typeof row.path !== 'string' || !row.name || !row.path) continue;
    const scope = row.scope === 'repo' ? 'repo' : 'user';
    const id = `${scope}:${row.name}:${row.path}`;
    const skill: Skill = { id, name: row.name, path: row.path, skillPath: row.path, scope,
      type: 'file', enabled: row.enabled !== false,
      ...(typeof row.description === 'string' ? { description: row.description } : {}) };
    config[scope]![id] = skill;
  }
  return config;
}
