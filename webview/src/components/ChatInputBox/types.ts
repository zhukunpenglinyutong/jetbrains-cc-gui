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
  /** 触发符号 ('@' 或 '/') */
  trigger: string;
  /** 搜索关键词 */
  query: string;
  /** 触发符号的字符偏移位置 */
  start: number;
  /** 查询结束的字符偏移位置 */
  end: number;
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
}

/**
 * 预定义模式列表
 */
export const AVAILABLE_MODES: ModeInfo[] = [
  { id: 'default', label: '默认模式', icon: 'codicon-comment-discussion' },
  { id: 'acceptEdits', label: '代理模式', icon: 'codicon-robot' },
  { id: 'plan', label: '规划模式', icon: 'codicon-tasklist' },
  { id: 'bypassPermissions', label: '自动模式', icon: 'codicon-zap' },
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
 * 预定义模型列表
 */
export const AVAILABLE_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
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
  /** 使用量百分比 */
  usagePercentage?: number;
  /** 已用上下文token */
  usageUsedTokens?: number;
  /** 上下文最大token */
  usageMaxTokens?: number;
  /** 是否显示使用量 */
  showUsage?: boolean;
  /** 附件列表 */
  attachments?: Attachment[];
  /** 占位符文本 */
  placeholder?: string;
  /** 是否禁用 */
  disabled?: boolean;

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
  /** 当前模型 */
  selectedModel?: string;
  /** 当前模式 */
  permissionMode?: PermissionMode;
  /** 使用量百分比 */
  usagePercentage?: number;
  /** 已用上下文token */
  usageUsedTokens?: number;
  /** 上下文最大token */
  usageMaxTokens?: number;
  /** 是否显示进度 */
  showUsage?: boolean;

  // 事件回调
  onSubmit?: () => void;
  onStop?: () => void;
  onAddAttachment?: (files: FileList) => void;
  onModeSelect?: (mode: PermissionMode) => void;
  onModelSelect?: (modelId: string) => void;
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
