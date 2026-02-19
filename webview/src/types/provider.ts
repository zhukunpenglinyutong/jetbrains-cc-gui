/**
 * Provider configuration type definitions
 */

// ============ Constants ============

/**
 * localStorage keys for provider-related data
 */
export const STORAGE_KEYS = {
  /** Custom Codex model list */
  CODEX_CUSTOM_MODELS: 'codex-custom-models',
  /** Claude model mapping configuration */
  CLAUDE_MODEL_MAPPING: 'claude-model-mapping',
  /** Custom Claude model list */
  CLAUDE_CUSTOM_MODELS: 'claude-custom-models',
} as const;

/**
 * Model ID validation regular expression
 * Allowed: letters, numbers, hyphens, underscores, dots, slashes, colons
 * Used to validate user-input model ID format
 */
export const MODEL_ID_PATTERN = /^[a-zA-Z0-9._\-/:]+$/;

// ============ Validation Helpers ============

/**
 * Validate whether a model ID format is valid
 * @param id - Model ID
 * @returns Whether the ID is valid
 */
export function isValidModelId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  return MODEL_ID_PATTERN.test(trimmed);
}

/**
 * Validate whether a CodexCustomModel object is valid
 * @param model - Object to validate
 * @returns Whether it is a valid CodexCustomModel
 */
export function isValidCodexCustomModel(model: unknown): model is CodexCustomModel {
  if (!model || typeof model !== 'object') return false;
  const obj = model as Record<string, unknown>;

  // id must be a valid model ID
  if (typeof obj.id !== 'string' || !isValidModelId(obj.id)) return false;

  // label must be a string
  if (typeof obj.label !== 'string' || obj.label.trim().length === 0) return false;

  // description is optional, but must be a string if present
  if (obj.description !== undefined && typeof obj.description !== 'string') return false;

  return true;
}

/**
 * Validate and filter a CodexCustomModel array
 * @param models - Array to validate
 * @returns Array of valid CodexCustomModel entries
 */
export function validateCodexCustomModels(models: unknown): CodexCustomModel[] {
  if (!Array.isArray(models)) return [];
  return models.filter(isValidCodexCustomModel);
}

// ============ Types ============

/**
 * Provider configuration (simplified, adapted for current project)
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
  /** Custom model list (displayed before built-in models in the selector) */
  customModels?: CodexCustomModel[];
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
 * Provider category
 */
export type ProviderCategory =
  | 'official'      // Official
  | 'cn_official'   // Chinese official
  | 'aggregator'    // Aggregator service
  | 'third_party'   // Third-party
  | 'custom';       // Custom

/**
 * Codex custom model configuration
 */
export interface CodexCustomModel {
  /** Model ID (unique identifier) */
  id: string;
  /** Model display name */
  label: string;
  /** Model description */
  description?: string;
}

/**
 * Codex provider configuration
 */
export interface CodexProviderConfig {
  /** Unique provider ID */
  id: string;
  /** Provider name */
  name: string;
  /** Remark */
  remark?: string;
  /** Creation timestamp (milliseconds) */
  createdAt?: number;
  /** Whether this is the currently active provider */
  isActive?: boolean;
  /** config.toml content (raw string) */
  configToml?: string;
  /** auth.json content (raw string) */
  authJson?: string;
  /** Custom model list */
  customModels?: CodexCustomModel[];
}

// ============ Provider Presets ============

/**
 * Provider preset configuration
 */
export interface ProviderPreset {
  /** Unique preset ID */
  id: string;
  /** i18n key for preset name, resolved at render time */
  nameKey: string;
  /** Environment variable configuration */
  env: Record<string, string>;
}

/**
 * Provider preset configuration list
 * Used for quick provider setup
 *
 * nameKey is resolved at render time via t() to the display name for the current language
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
      // MiniMax models respond slowly; requires 50-minute timeout (3,000,000ms) to avoid truncating long reasoning requests
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
