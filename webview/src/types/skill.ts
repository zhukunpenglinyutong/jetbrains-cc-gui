/**
 * Skills type definitions
 *
 * Skills are custom command and feature extensions stored in specific directories:
 * - Global: ~/.claude/skills (enabled) / ~/.codemoss/skills/global (disabled)
 * - Local: {workspace}/.claude/skills (enabled) / ~/.codemoss/skills/{project-hash} (disabled)
 *
 * Each skill can be a file (.md) or a directory (containing skill.md)
 */

/**
 * Skill type: file or directory
 */
export type SkillType = 'file' | 'directory';

/**
 * Skill scope: global or local
 */
export type SkillScope = 'global' | 'local';

/**
 * Skill configuration
 */
export interface Skill {
  /** Unique identifier (format: {scope}-{name} or {scope}-{name}-disabled) */
  id: string;
  /** Display name */
  name: string;
  /** Type: file or directory */
  type: SkillType;
  /** Scope: global or local */
  scope: SkillScope;
  /** Full path */
  path: string;
  /** Whether enabled (true: in active directory, false: in managed directory) */
  enabled: boolean;
  /** Description (extracted from skill.md frontmatter) */
  description?: string;
  /** Creation time */
  createdAt?: string;
  /** Modification time */
  modifiedAt?: string;
}

/**
 * Skills map (id -> Skill)
 */
export type SkillsMap = Record<string, Skill>;

/**
 * Skills configuration structure
 */
export interface SkillsConfig {
  /** Global skills */
  global: SkillsMap;
  /** Local skills */
  local: SkillsMap;
}

/**
 * Skills filter
 */
export type SkillFilter = 'all' | 'global' | 'local';

/**
 * Skills enabled status filter
 */
export type SkillEnabledFilter = 'all' | 'enabled' | 'disabled';
