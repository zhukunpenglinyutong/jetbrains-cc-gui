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
  /** 官网链接 */
  websiteUrl?: string;
  /** 供应商分类 */
  category?: ProviderCategory;
  /** 创建时间戳（毫秒） */
  createdAt?: number;
  /** 是否为当前使用的供应商 */
  isActive?: boolean;
  /** 配置信息 */
  settingsConfig?: {
    env?: {
      ANTHROPIC_AUTH_TOKEN?: string;
      ANTHROPIC_BASE_URL?: string;
      [key: string]: any;
    };
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
