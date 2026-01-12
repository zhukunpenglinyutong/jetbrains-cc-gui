/**
 * 输入框组件类型定义
 * 功能: 004-refactor-input-box
 */

// ============================================================
// 核心实体类型
// ============================================================

/**
 * 文件附件
 */
export interface Attachment {
  /** 唯一标识符 */
  id: string;
  /** 原始文件名 */
  fileName: string;
  /** MIME 类型 */
  mediaType: string;
  /** Base64 编码内容 */
  data: string;
}

/**
 * 代码片段（来自编辑器选中的代码）
 */
export interface CodeSnippet {
  /** 唯一标识符 */
  id: string;
  /** 文件路径（相对路径） */
  filePath: string;
  /** 起始行号 */
  startLine?: number;
  /** 结束行号 */
  endLine?: number;
}

/**
 * 图片媒体类型常量
 */
export const IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * 判断是否为图片附件
 */
export function isImageAttachment(attachment: Attachment): boolean {
  return IMAGE_MEDIA_TYPES.includes(attachment.mediaType as ImageMediaType);
}

// ============================================================
// 补全系统类型
// ============================================================

/**
 * 补全项类型
 */
export type CompletionType =
  | 'file'
  | 'directory'
  | 'command'
  | 'agent'
  | 'info'
  | 'separator'
  | 'section-header';

/**
 * 下拉菜单项数据
 */
export interface DropdownItemData {
  /** 唯一标识符 */
  id: string;
  /** 显示文本 */
  label: string;
  /** 描述文本 */
  description?: string;
  /** 图标类名 */
  icon?: string;
  /** 项类型 */
  type: CompletionType;
  /** 是否选中（用于选择器） */
  checked?: boolean;
  /** 关联数据 */
  data?: Record<string, unknown>;
}

/**
 * 文件项（Java 返回）
 */
export interface FileItem {
  /** 文件名 */
  name: string;
  /** 相对路径 */
  path: string;
  /** 绝对路径 (可选) */
  absolutePath?: string;
  /** 类型 */
  type: 'file' | 'directory';
  /** 扩展名 */
  extension?: string;
}

/**
 * 命令项（Java 返回）
 */
export interface CommandItem {
  /** 命令标识 */
  id: string;
  /** 显示名称 */
  label: string;
  /** 描述 */
  description?: string;
  /** 分类 */
  category?: string;
}

/**
 * 下拉菜单位置
 */
export interface DropdownPosition {
  /** 顶部坐标 (px) */
  top: number;
  /** 左侧坐标 (px) */
  left: number;
  /** 宽度 (px) */
  width: number;
  /** 高度 (px) */
  height: number;
}

/**
 * 触发查询信息
 */
export interface TriggerQuery {
  /** 触发符号 ('@' 或 '/' 或 '#') */
  trigger: string;
  /** 搜索关键词 */
  query: string;
  /** 触发符号的字符偏移位置 */
  start: number;
  /** 查询结束的字符偏移位置 */
  end: number;
}

/**
 * 选中的智能体信息
 */
export interface SelectedAgent {
  id: string;
  name: string;
  prompt?: string;
}

// ============================================================
// 模式与模型类型
// ============================================================

/**
 * 对话权限模式
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * 模式信息
 */
export interface ModeInfo {
  id: PermissionMode;
  label: string;
  icon: string;
  disabled?: boolean;
  tooltip?: string;
  description?: string;  // 模式描述文案
}

/**
 * 预定义模式列表
 */
export const AVAILABLE_MODES: ModeInfo[] = [
  {
    id: 'default',
    label: '默认模式',
    icon: 'codicon-comment-discussion',
    tooltip: '标准权限行为',
    description: '需要手动确认每个操作，适合谨慎使用'
  },
  {
    id: 'plan',
    label: '规划模式',
    icon: 'codicon-tasklist',
    disabled: true,
    tooltip: '规划模式——无执行（暂不支持）',
    description: '仅规划不执行，暂不支持'
  },
  {
    id: 'acceptEdits',
    label: '代理模式',
    icon: 'codicon-robot',
    tooltip: '自动接受文件编辑',
    description: '自动接受文件创建/编辑，减少确认步骤'
  },
  {
    id: 'bypassPermissions',
    label: '自动模式',
    icon: 'codicon-zap',
    tooltip: '绕过所有权限检查',
    description: '完全自动化，绕过所有权限检查【谨慎使用】'
  },
];

/**
 * 模型信息
 */
export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
}

/**
 * Claude 模型列表
 */
export const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    description: 'Sonnet 4.5 · Use the default model',
  },
  {
    id: 'claude-opus-4-5-20251101',
    label: 'Opus 4.5',
    description: 'Opus 4.5 · Most capable for complex work',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    description: 'Haiku 4.5 · Fastest for quick answers',
  },
];

/**
 * Codex 模型列表
 */
export const CODEX_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.2-codex',
    label: 'gpt-5.2-codex',
    description: 'Latest frontier agentic coding model.'
  },
  {
    id: 'gpt-5.1-codex-max',
    label: 'gpt-5.1-codex-max',
    description: 'Codex-optimized flagship for deep and fast reasoning.'
  },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'gpt-5.1-codex-mini',
    description: 'Optimized for codex. Cheaper, faster, but less capable.'
  },
  {
    id: 'gpt-5.2',
    label: 'gpt-5.2',
    description: 'Latest frontier model with improvements across knowledge.'
  },
];

/**
 * 预定义模型列表（向后兼容）
 */
export const AVAILABLE_MODELS = CLAUDE_MODELS;

/**
 * AI 提供商信息
 */
export interface ProviderInfo {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
}

/**
 * 预定义提供商列表
 */
export const AVAILABLE_PROVIDERS: ProviderInfo[] = [
  { id: 'claude', label: 'Claude Code', icon: 'codicon-terminal', enabled: true },
  { id: 'codex', label: 'Codex Cli', icon: 'codicon-terminal', enabled: true },
  { id: 'gemini', label: 'Gemini Cli', icon: 'codicon-terminal', enabled: false },
];

/**
 * Codex Reasoning Effort (思考深度)
 * Controls the depth of reasoning for Codex models
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Reasoning level information
 */
export interface ReasoningInfo {
  id: ReasoningEffort;
  label: string;
  icon: string;
  description?: string;
}

/**
 * Available reasoning levels for Codex
 */
export const REASONING_LEVELS: ReasoningInfo[] = [
  { id: 'minimal', label: 'Minimal', icon: 'codicon-circle-outline', description: 'Fastest, minimal thinking' },
  { id: 'low', label: 'Low', icon: 'codicon-circle-small', description: 'Quick responses with basic reasoning' },
  { id: 'medium', label: 'Medium', icon: 'codicon-circle-filled', description: 'Balanced thinking (default)' },
  { id: 'high', label: 'High', icon: 'codicon-circle-large-filled', description: 'Deep reasoning for complex tasks' },
];

// ============================================================
// 使用量类型
// ============================================================

/**
 * 使用量信息
 */
export interface UsageInfo {
  /** 使用百分比 (0-100) */
  percentage: number;
  /** 已用量 */
  used?: number;
  /** 总量 */
  total?: number;
}

// ============================================================
// 组件 Props 类型
// ============================================================

/**
 * ChatInputBox 组件 Props
 */
export interface ChatInputBoxProps {
  /** 是否正在加载 */
  isLoading?: boolean;
  /** 当前模型 */
  selectedModel?: string;
  /** 当前模式 */
  permissionMode?: PermissionMode;
  /** 当前提供商 */
  currentProvider?: string;
  /** 使用量百分比 */
  usagePercentage?: number;
  /** 已用上下文token */
  usageUsedTokens?: number;
  /** 上下文最大token */
  usageMaxTokens?: number;
  /** 是否显示使用量 */
  showUsage?: boolean;
  /** 是否开启始终思考 */
  alwaysThinkingEnabled?: boolean;
  /** 附件列表 */
  attachments?: Attachment[];
  /** 占位符文本 */
  placeholder?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 受控模式：输入框内容 */
  value?: string;

  /** 当前活动文件 */
  activeFile?: string;
  /** 选中行数信息 (例如: "L10-20") */
  selectedLines?: string;

  /** 清除上下文回调 */
  onClearContext?: () => void;
  /** 移除代码片段回调 */
  onRemoveCodeSnippet?: (id: string) => void;

  // 事件回调
  /** 提交消息 */
  onSubmit?: (content: string, attachments?: Attachment[]) => void;
  /** 停止生成 */
  onStop?: () => void;
  /** 输入变化 */
  onInput?: (content: string) => void;
  /** 添加附件 */
  onAddAttachment?: (files: FileList) => void;
  /** 移除附件 */
  onRemoveAttachment?: (id: string) => void;
  /** 切换模式 */
  onModeSelect?: (mode: PermissionMode) => void;
  /** 切换模型 */
  onModelSelect?: (modelId: string) => void;
  /** 切换提供商 */
  onProviderSelect?: (providerId: string) => void;
  /** 当前思考深度 (Codex only) */
  reasoningEffort?: ReasoningEffort;
  /** 切换思考深度回调 (Codex only) */
  onReasoningChange?: (effort: ReasoningEffort) => void;
  /** 切换思考模式 */
  onToggleThinking?: (enabled: boolean) => void;
  /** 是否开启流式传输 */
  streamingEnabled?: boolean;
  /** 切换流式传输 */
  onStreamingEnabledChange?: (enabled: boolean) => void;

  /** 当前选中的智能体 */
  selectedAgent?: SelectedAgent | null;
  /** 选择智能体回调 */
  onAgentSelect?: (agent: SelectedAgent | null) => void;
  /** 清除智能体回调 */
  onClearAgent?: () => void;
  /** 打开智能体设置回调 */
  onOpenAgentSettings?: () => void;

  /** 是否有消息（用于回滚按钮显示） */
  hasMessages?: boolean;
  /** 回溯文件回调 */
  onRewind?: () => void;

  /** 🔧 SDK 是否已安装（用于在未安装时禁止提问） */
  sdkInstalled?: boolean;
  /** 🔧 SDK 状态是否正在加载 */
  sdkStatusLoading?: boolean;
  /** 🔧 前往安装 SDK 回调 */
  onInstallSdk?: () => void;
  /** 显示 Toast 提示 */
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

/**
 * ButtonArea 组件 Props
 */
export interface ButtonAreaProps {
  /** 是否禁用提交 */
  disabled?: boolean;
  /** 是否有输入内容 */
  hasInputContent?: boolean;
  /** 是否在对话中 */
  isLoading?: boolean;
  /** 是否正在增强提示词 */
  isEnhancing?: boolean;
  /** 当前模型 */
  selectedModel?: string;
  /** 当前模式 */
  permissionMode?: PermissionMode;
  /** 当前提供商 */
  currentProvider?: string;
  /** 当前思考深度 (Codex only) */
  reasoningEffort?: ReasoningEffort;

  // 事件回调
  onSubmit?: () => void;
  onStop?: () => void;
  onModeSelect?: (mode: PermissionMode) => void;
  onModelSelect?: (modelId: string) => void;
  onProviderSelect?: (providerId: string) => void;
  /** 切换思考深度回调 (Codex only) */
  onReasoningChange?: (effort: ReasoningEffort) => void;
  /** 增强提示词回调 */
  onEnhancePrompt?: () => void;
  /** 是否开启始终思考 */
  alwaysThinkingEnabled?: boolean;
  /** 切换思考模式 */
  onToggleThinking?: (enabled: boolean) => void;
  /** 是否开启流式传输 */
  streamingEnabled?: boolean;
  /** 切换流式传输 */
  onStreamingEnabledChange?: (enabled: boolean) => void;
  /** 当前选中的智能体 */
  selectedAgent?: SelectedAgent | null;
  /** 智能体选择回调 */
  onAgentSelect?: (agent: SelectedAgent) => void;
  /** 清除智能体回调 */
  onClearAgent?: () => void;
  /** 打开智能体设置回调 */
  onOpenAgentSettings?: () => void;
}

/**
 * Dropdown 组件 Props
 */
export interface DropdownProps {
  /** 是否可见 */
  isVisible: boolean;
  /** 位置信息 */
  position: DropdownPosition | null;
  /** 宽度 */
  width?: number;
  /** Y 轴偏移 */
  offsetY?: number;
  /** X 轴偏移 */
  offsetX?: number;
  /** 选中索引 */
  selectedIndex?: number;
  /** 关闭回调 */
  onClose?: () => void;
  /** 子元素 */
  children: React.ReactNode;
}

/**
 * TokenIndicator 组件 Props
 */
export interface TokenIndicatorProps {
  /** 百分比 (0-100) */
  percentage: number;
  /** 尺寸 */
  size?: number;
  /** 已用上下文token */
  usedTokens?: number;
  /** 上下文最大token */
  maxTokens?: number;
}

/**
 * AttachmentList 组件 Props
 */
export interface AttachmentListProps {
  /** 附件列表 */
  attachments: Attachment[];
  /** 移除附件回调 */
  onRemove?: (id: string) => void;
  /** 预览图片回调 */
  onPreview?: (attachment: Attachment) => void;
}

/**
 * DropdownItem 组件 Props
 */
export interface DropdownItemProps {
  /** 项数据 */
  item: DropdownItemData;
  /** 是否高亮 */
  isActive?: boolean;
  /** 点击回调 */
  onClick?: () => void;
  /** 鼠标进入回调 */
  onMouseEnter?: () => void;
}
