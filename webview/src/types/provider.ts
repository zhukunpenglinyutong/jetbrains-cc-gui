/**
 * 供应商配置相关类型定义
 */

/**
 * 供应商配置（简化版，适配当前项目）
 */
export interface ProviderConfig {
  /** 供应商唯一 ID */
  id: string;
  /** 供应商名称 */
  name: string;
  /** 备注 */
  remark?: string;
  /** 官网链接 (已弃用，保留兼容) */
  websiteUrl?: string;
  /** 供应商分类 */
  category?: ProviderCategory;
  /** 创建时间戳（毫秒） */
  createdAt?: number;
  /** 是否为当前使用的供应商 */
  isActive?: boolean;
  /** 来源 */
  source?: 'cc-switch' | string;
  /** 配置信息 */
  settingsConfig?: {
    env?: {
      ANTHROPIC_AUTH_TOKEN?: string;
      ANTHROPIC_BASE_URL?: string;
      ANTHROPIC_MODEL?: string;
      ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
      ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
      ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
      [key: string]: any;
    };
    alwaysThinkingEnabled?: boolean;
    permissions?: {
      allow?: string[];
      deny?: string[];
    };
  };
}

/**
 * 供应商分类
 */
export type ProviderCategory =
  | 'official'      // 官方
  | 'cn_official'   // 国产官方
  | 'aggregator'    // 聚合服务
  | 'third_party'   // 第三方
  | 'custom';       // 自定义

/**
 * Codex 供应商配置
 */
export interface CodexProviderConfig {
  /** 供应商唯一 ID */
  id: string;
  /** 供应商名称 */
  name: string;
  /** 备注 */
  remark?: string;
  /** 创建时间戳（毫秒） */
  createdAt?: number;
  /** 是否为当前使用的供应商 */
  isActive?: boolean;
  /** config.toml 配置内容（原始字符串） */
  configToml?: string;
  /** auth.json 配置内容（原始字符串） */
  authJson?: string;
}
