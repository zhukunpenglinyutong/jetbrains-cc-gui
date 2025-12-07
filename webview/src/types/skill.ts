/**
 * Skills 类型定义
 *
 * Skills 是自定义的命令和功能扩展，存储在特定目录中：
 * - 全局: ~/.claude/skills（启用）/ ~/.codemoss/skills/global（停用）
 * - 本地: {workspace}/.claude/skills（启用）/ ~/.codemoss/skills/{项目哈希}（停用）
 *
 * 每个 Skill 可以是文件（.md）或目录（包含 skill.md）
 */

/**
 * Skill 类型：文件或目录
 */
export type SkillType = 'file' | 'directory';

/**
 * Skill 作用域：全局或本地
 */
export type SkillScope = 'global' | 'local';

/**
 * Skill 配置
 */
export interface Skill {
  /** 唯一标识符（格式：{scope}-{name} 或 {scope}-{name}-disabled） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 类型：文件或目录 */
  type: SkillType;
  /** 作用域：全局或本地 */
  scope: SkillScope;
  /** 完整路径 */
  path: string;
  /** 是否启用（true: 在使用中目录，false: 在管理目录） */
  enabled: boolean;
  /** 描述（从 skill.md 的 frontmatter 提取） */
  description?: string;
  /** 创建时间 */
  createdAt?: string;
  /** 修改时间 */
  modifiedAt?: string;
}

/**
 * Skills 映射 (id -> Skill)
 */
export type SkillsMap = Record<string, Skill>;

/**
 * Skills 配置结构
 */
export interface SkillsConfig {
  /** 全局 Skills */
  global: SkillsMap;
  /** 本地 Skills */
  local: SkillsMap;
}

/**
 * Skills 筛选器
 */
export type SkillFilter = 'all' | 'global' | 'local';

/**
 * Skills 启用状态筛选器
 */
export type SkillEnabledFilter = 'all' | 'enabled' | 'disabled';
