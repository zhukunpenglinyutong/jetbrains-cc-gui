/**
 * SDK 依赖类型定义
 *
 * SDK 依赖安装位置: ~/.codemoss/dependencies/
 * - claude-sdk: Claude SDK (@anthropic-ai/claude-agent-sdk 及其依赖)
 * - codex-sdk: Codex SDK (@openai/codex-sdk)
 *
 * 支持的操作:
 * - 安装/卸载 SDK
 * - 检查更新
 * - 查看安装状态
 */

/**
 * SDK ID 类型
 */
export type SdkId = 'claude-sdk' | 'codex-sdk';

/**
 * SDK 安装状态
 */
export type SdkInstallStatus = 'installed' | 'not_installed' | 'installing' | 'error';

/**
 * 单个 SDK 的状态信息
 */
export interface SdkStatus {
  /** SDK 唯一标识 */
  id: SdkId;
  /** SDK 显示名称 */
  name: string;
  /** 安装状态 */
  status: SdkInstallStatus;
  /** 已安装版本（未安装时为空） */
  installedVersion?: string;
  /** 最新可用版本 */
  latestVersion?: string;
  /** 是否有可用更新 */
  hasUpdate?: boolean;
  /** 安装路径 */
  installPath?: string;
  /** 描述信息 */
  description?: string;
  /** 最后检查时间 */
  lastChecked?: string;
  /** 错误信息（状态为 error 时） */
  errorMessage?: string;
}

/**
 * 所有 SDK 的状态映射
 */
export interface DependencyStatus {
  [key: string]: SdkStatus;
}

/**
 * 安装进度信息
 */
export interface InstallProgress {
  /** SDK ID */
  sdkId: SdkId;
  /** 日志输出 */
  log: string;
}

/**
 * 安装结果
 */
export interface InstallResult {
  /** 是否成功 */
  success: boolean;
  /** SDK ID */
  sdkId: SdkId;
  /** 安装的版本（成功时） */
  installedVersion?: string;
  /** 错误信息（失败时） */
  error?: string;
  /** 安装日志 */
  logs?: string;
}

/**
 * 卸载结果
 */
export interface UninstallResult {
  /** 是否成功 */
  success: boolean;
  /** SDK ID */
  sdkId: SdkId;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 更新信息
 */
export interface UpdateInfo {
  /** SDK ID */
  sdkId: SdkId;
  /** SDK 名称 */
  sdkName: string;
  /** 是否有更新 */
  hasUpdate: boolean;
  /** 当前版本 */
  currentVersion?: string;
  /** 最新版本 */
  latestVersion?: string;
  /** 错误信息 */
  error?: string;
}

/**
 * 更新检查结果
 */
export interface UpdateCheckResult {
  [key: string]: UpdateInfo;
}

/**
 * Node.js 环境状态
 */
export interface NodeEnvironmentStatus {
  /** 是否可用 */
  available: boolean;
  /** 错误信息 */
  error?: string;
}

/**
 * SDK 定义（用于 UI 展示）
 */
export interface SdkDefinition {
  /** SDK ID */
  id: SdkId;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 相关的 provider（用于关联功能） */
  relatedProviders: string[];
}

/**
 * 预定义的 SDK 列表
 */
export const SDK_DEFINITIONS: SdkDefinition[] = [
  {
    id: 'claude-sdk',
    name: 'Claude Code SDK',
    description: 'Claude AI 提供商所需。包含 @anthropic-ai/claude-agent-sdk 及相关依赖。',
    relatedProviders: ['anthropic', 'bedrock'],
  },
  {
    id: 'codex-sdk',
    name: 'Codex SDK',
    description: 'Codex AI 提供商所需。包含 @openai/codex-sdk。',
    relatedProviders: ['openai'],
  },
];
