/**
 * 供应商配置相关类型定义
 */

// ============ Constants ============

/**
 * localStorage keys for provider-related data
 */
export const STORAGE_KEYS = {
  /** 自定义 Codex 模型列表 */
  CODEX_CUSTOM_MODELS: 'codex-custom-models',
  /** Claude 模型映射配置 */
  CLAUDE_MODEL_MAPPING: 'claude-model-mapping',
} as const;

/**
 * 模型 ID 验证正则表达式
 * 允许: 字母、数字、连字符、下划线、点、斜杠、冒号
 * 用于验证用户输入的模型 ID 格式
 */
export const MODEL_ID_PATTERN = /^[a-zA-Z0-9._\-/:]+$/;

// ============ Validation Helpers ============

/**
 * 验证模型 ID 格式是否有效
 * @param id 模型 ID
 * @returns 是否有效
 */
export function isValidModelId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  return MODEL_ID_PATTERN.test(trimmed);
}

/**
 * 验证 CodexCustomModel 对象是否有效
 * @param model 待验证的对象
 * @returns 是否为有效的 CodexCustomModel
 */
export function isValidCodexCustomModel(model: unknown): model is CodexCustomModel {
  if (!model || typeof model !== 'object') return false;
  const obj = model as Record<string, unknown>;

  // id 必须是有效的模型 ID
  if (typeof obj.id !== 'string' || !isValidModelId(obj.id)) return false;

  // label 必须是字符串
  if (typeof obj.label !== 'string' || obj.label.trim().length === 0) return false;

  // description 可选，但如果存在必须是字符串
  if (obj.description !== undefined && typeof obj.description !== 'string') return false;

  return true;
}

/**
 * 验证并过滤 CodexCustomModel 数组
 * @param models 待验证的数组
 * @returns 有效的 CodexCustomModel 数组
 */
export function validateCodexCustomModels(models: unknown): CodexCustomModel[] {
  if (!Array.isArray(models)) return [];
  return models.filter(isValidCodexCustomModel);
}

// ============ Types ============

/**
 * 供应商配置（简化版，适配当前项目）
 */
export interface ProviderConfig {
  id: string;
  name: string;
  remark?: string;
  websiteUrl?: string;
  category?: ProviderCategory;
  createdAt?: number;
  isActive?: boolean;
  source?: 'cc-switch' | string;
  isLocalProvider?: boolean;
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
 * Codex 自定义模型配置
 */
export interface CodexCustomModel {
  /** 模型 ID（唯一标识） */
  id: string;
  /** 模型显示名称 */
  label: string;
  /** 模型描述 */
  description?: string;
}

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
  /** 自定义模型列表 */
  customModels?: CodexCustomModel[];
}

// ============ Provider Presets ============

/**
 * 供应商预设配置
 */
export interface ProviderPreset {
  /** 预设唯一 ID */
  id: string;
  /** i18n key for preset name, resolved at render time */
  nameKey: string;
  /** 环境变量配置 */
  env: Record<string, string>;
}

/**
 * 供应商预设配置列表
 * 用于快捷配置供应商
 *
 * nameKey 在渲染时通过 t() 解析为对应语言的显示名称
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'custom',
    nameKey: 'settings.provider.presets.custom',
    env: {},
  },
  {
    id: 'zhipu',
    nameKey: 'settings.provider.presets.zhipu',
    env: {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
    },
  },
  {
    id: 'kimi',
    nameKey: 'settings.provider.presets.kimi',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'kimi-k2.5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.5',
    },
  },
  {
    id: 'deepseek',
    nameKey: 'settings.provider.presets.deepseek',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'DeepSeek-V3.2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'DeepSeek-V3.2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'DeepSeek-V3.2',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'DeepSeek-V3.2',
    },
  },
  {
    id: 'minimax',
    nameKey: 'settings.provider.presets.minimax',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      // MiniMax 模型响应较慢，需要 50 分钟超时（3,000,000ms）以避免长推理请求被截断
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_MODEL: 'MiniMax-M2.1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.1',
    },
  },
  {
    id: 'xiaomi',
    nameKey: 'settings.provider.presets.xiaomi',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'mimo-v2-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2-flash',
    },
  },
];
