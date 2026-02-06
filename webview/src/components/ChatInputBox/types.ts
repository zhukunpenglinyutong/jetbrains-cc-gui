/**
 * Input box component type definitions
 * Feature: 004-refactor-input-box
 */

// ============================================================
// Core Entity Types
// ============================================================

/**
 * File tag information for backend context injection (Codex mode)
 */
export interface FileTagInfo {
  /** Display path (as shown in tag) */
  displayPath: string;
  /** Absolute path (for file reading) */
  absolutePath: string;
}

/**
 * File attachment
 */
export interface Attachment {
  /** Unique identifier */
  id: string;
  /** Original filename */
  fileName: string;
  /** MIME type */
  mediaType: string;
  /** Base64 encoded content */
  data: string;
}

/**
 * Code snippet (from editor selection)
 */
export interface CodeSnippet {
  /** Unique identifier */
  id: string;
  /** File path (relative) */
  filePath: string;
  /** Start line number */
  startLine?: number;
  /** End line number */
  endLine?: number;
}

/**
 * Image media type constants
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
 * Check if attachment is an image
 */
export function isImageAttachment(attachment: Attachment): boolean {
  return IMAGE_MEDIA_TYPES.includes(attachment.mediaType as ImageMediaType);
}

// ============================================================
// Completion System Types
// ============================================================

/**
 * Completion item type
 */
export type CompletionType =
  | 'file'
  | 'directory'
  | 'command'
  | 'agent'
  | 'terminal'
  | 'service'
  | 'info'
  | 'separator'
  | 'section-header';

/**
 * Dropdown menu item data
 */
export interface DropdownItemData {
  /** Unique identifier */
  id: string;
  /** Display text */
  label: string;
  /** Description text */
  description?: string;
  /** Icon class name */
  icon?: string;
  /** Item type */
  type: CompletionType;
  /** Whether selected (for selectors) */
  checked?: boolean;
  /** Associated data */
  data?: Record<string, unknown>;
}

/**
 * File item (returned from Java)
 */
export interface FileItem {
  /** Filename */
  name: string;
  /** Relative path */
  path: string;
  /** Absolute path (optional) */
  absolutePath?: string;
  /** 类型 */
  type: 'file' | 'directory' | 'terminal' | 'service';
  /** 扩展名 */
  extension?: string;
}

/**
 * Command item (returned from Java)
 */
export interface CommandItem {
  /** Command identifier */
  id: string;
  /** Display name */
  label: string;
  /** Description */
  description?: string;
  /** Category */
  category?: string;
}

/**
 * Dropdown menu position
 */
export interface DropdownPosition {
  /** Top coordinate (px) */
  top: number;
  /** Left coordinate (px) */
  left: number;
  /** Width (px) */
  width: number;
  /** Height (px) */
  height: number;
}

/**
 * Trigger query information
 */
export interface TriggerQuery {
  /** Trigger symbol ('@' or '/' or '#') */
  trigger: string;
  /** Search keyword */
  query: string;
  /** Character offset position of trigger symbol */
  start: number;
  /** Character offset position of query end */
  end: number;
}

/**
 * Selected agent information
 */
export interface SelectedAgent {
  id: string;
  name: string;
  prompt?: string;
}

// ============================================================
// Mode and Model Types
// ============================================================

/**
 * Permission mode for conversations
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * Mode information
 */
export interface ModeInfo {
  id: PermissionMode;
  label: string;
  icon: string;
  disabled?: boolean;
  tooltip?: string;
  description?: string;
}

/**
 * Available permission modes
 */
export const AVAILABLE_MODES: ModeInfo[] = [
  {
    id: 'default',
    label: 'Default Mode',
    icon: 'codicon-comment-discussion',
    tooltip: 'Standard permission behavior',
    description: 'Requires manual confirmation for each operation',
  },
  {
    id: 'plan',
    label: 'Plan Mode',
    icon: 'codicon-tasklist',
    tooltip: 'Plan mode - read-only analysis',
    description: 'Read-only tools only, generates plan for user approval',
  },
  {
    id: 'acceptEdits',
    label: 'Agent Mode',
    icon: 'codicon-robot',
    tooltip: 'Auto-accept file edits',
    description: 'Auto-accept file creation/editing, fewer confirmations',
  },
  {
    id: 'bypassPermissions',
    label: 'Auto Mode',
    icon: 'codicon-zap',
    tooltip: 'Bypass all permission checks',
    description: 'Fully automated, bypasses all permission checks [use with caution]',
  },
];

/**
 * Model information
 */
export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
}

/**
 * Claude model list
 */
export const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    description: 'Sonnet 4.5 · Use the default model',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    description: 'Opus 4.6 · Latest and most capable',
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
 * Codex model list
 */
export const CODEX_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.3-codex',
    label: 'gpt-5.3-codex',
    description: 'Latest frontier agentic coding model with enhanced capabilities.',
  },
  {
    id: 'gpt-5.3',
    label: 'gpt-5.3',
    description: 'Latest frontier model with significant improvements.',
  },
  {
    id: 'gpt-5.2-codex',
    label: 'gpt-5.2-codex',
    description: 'Latest frontier agentic coding model.',
  },
  {
    id: 'gpt-5.2',
    label: 'gpt-5.2',
    description: 'Latest frontier model with improvements across knowledge.',
  },
  {
    id: 'gpt-5.1-codex-max',
    label: 'gpt-5.1-codex-max',
    description: 'Codex-optimized flagship for deep and fast reasoning.',
  },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'gpt-5.1-codex-mini',
    description: 'Optimized for codex. Cheaper, faster, but less capable.',
  },
];

/**
 * Available models (backward compatibility)
 */
export const AVAILABLE_MODELS = CLAUDE_MODELS;

/**
 * AI provider information
 */
export interface ProviderInfo {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
}

/**
 * Available AI providers
 */
export const AVAILABLE_PROVIDERS: ProviderInfo[] = [
  { id: 'claude', label: 'Claude Code', icon: 'codicon-terminal', enabled: true },
  { id: 'codex', label: 'Codex Cli', icon: 'codicon-terminal', enabled: true },
  { id: 'gemini', label: 'Gemini Cli', icon: 'codicon-terminal', enabled: false },
  { id: 'opencode', label: 'OpenCode', icon: 'codicon-terminal', enabled: false },
];

/**
 * Codex Reasoning Effort (thinking depth)
 * Controls the depth of reasoning for Codex models
 * Valid values: low, medium, high, xhigh
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

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
  {
    id: 'low',
    label: 'Low',
    icon: 'codicon-circle-small',
    description: 'Quick responses with basic reasoning',
  },
  {
    id: 'medium',
    label: 'Medium',
    icon: 'codicon-circle-filled',
    description: 'Balanced thinking (default)',
  },
  {
    id: 'high',
    label: 'High',
    icon: 'codicon-circle-large-filled',
    description: 'Deep reasoning for complex tasks',
  },
  {
    id: 'xhigh',
    label: 'Max',
    icon: 'codicon-flame',
    description: 'Maximum reasoning depth',
  },
];

// ============================================================
// Usage Types
// ============================================================

/**
 * Usage information
 */
export interface UsageInfo {
  /** Usage percentage (0-100) */
  percentage: number;
  /** Used amount */
  used?: number;
  /** Total amount */
  total?: number;
}

// ============================================================
// Component Ref Handle Types
// ============================================================

/**
 * ChatInputBox imperative API
 * Used for performance optimization - uncontrolled mode with imperative access
 */
export interface ChatInputBoxHandle {
  /** Get current input text content */
  getValue: () => string;
  /** Set input text content */
  setValue: (value: string) => void;
  /** Focus the input element */
  focus: () => void;
  /** Clear input content */
  clear: () => void;
  /** Check if input has content */
  hasContent: () => boolean;
  /** Get file tags from input (for Codex context injection) */
  getFileTags: () => FileTagInfo[];
}

// ============================================================
// Component Props Types
// ============================================================

/**
 * ChatInputBox component props
 */
export interface ChatInputBoxProps {
  /** Whether loading */
  isLoading?: boolean;
  /** Current model */
  selectedModel?: string;
  /** Current permission mode */
  permissionMode?: PermissionMode;
  /** Current provider */
  currentProvider?: string;
  /** Usage percentage */
  usagePercentage?: number;
  /** Used context tokens */
  usageUsedTokens?: number;
  /** Maximum context tokens */
  usageMaxTokens?: number;
  /** Whether to show usage */
  showUsage?: boolean;
  /** Whether always thinking is enabled */
  alwaysThinkingEnabled?: boolean;
  /** Attachment list */
  attachments?: Attachment[];
  /** Placeholder text */
  placeholder?: string;
  /** Whether disabled */
  disabled?: boolean;
  /** Controlled mode: input content */
  value?: string;

  /** Current active file */
  activeFile?: string;
  /** Selected lines info (e.g., "L10-20") */
  selectedLines?: string;

  /** Clear context callback */
  onClearContext?: () => void;
  /** Remove code snippet callback */
  onRemoveCodeSnippet?: (id: string) => void;

  // Event callbacks
  /** Submit message */
  onSubmit?: (content: string, attachments?: Attachment[]) => void;
  /** Stop generation */
  onStop?: () => void;
  /** Input change */
  onInput?: (content: string) => void;
  /** Add attachment */
  onAddAttachment?: (files: FileList) => void;
  /** Remove attachment */
  onRemoveAttachment?: (id: string) => void;
  /** Switch mode */
  onModeSelect?: (mode: PermissionMode) => void;
  /** Switch model */
  onModelSelect?: (modelId: string) => void;
  /** Switch provider */
  onProviderSelect?: (providerId: string) => void;
  /** Current reasoning effort (Codex only) */
  reasoningEffort?: ReasoningEffort;
  /** Switch reasoning effort callback (Codex only) */
  onReasoningChange?: (effort: ReasoningEffort) => void;
  /** Toggle thinking mode */
  onToggleThinking?: (enabled: boolean) => void;
  /** Whether streaming is enabled */
  streamingEnabled?: boolean;
  /** Toggle streaming */
  onStreamingEnabledChange?: (enabled: boolean) => void;

  /** Send shortcut setting: 'enter' = Enter sends | 'cmdEnter' = Cmd/Ctrl+Enter sends */
  sendShortcut?: 'enter' | 'cmdEnter';

  /** Currently selected agent */
  selectedAgent?: SelectedAgent | null;
  /** Select agent callback */
  onAgentSelect?: (agent: SelectedAgent | null) => void;
  /** Clear agent callback */
  onClearAgent?: () => void;
  /** Open agent settings callback */
  onOpenAgentSettings?: () => void;

  /** Whether has messages (for rewind button display) */
  hasMessages?: boolean;
  /** Rewind file callback */
  onRewind?: () => void;

  /** Whether StatusPanel is expanded */
  statusPanelExpanded?: boolean;
  /** Toggle StatusPanel expand/collapse */
  onToggleStatusPanel?: () => void;

  /** SDK installed status (disable input when not installed) */
  sdkInstalled?: boolean;
  /** SDK status loading state */
  sdkStatusLoading?: boolean;
  /** Go to install SDK callback */
  onInstallSdk?: () => void;
  /** Show toast message */
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;

  /** Message queue items */
  messageQueue?: QueuedMessage[];
  /** Remove message from queue callback */
  onRemoveFromQueue?: (id: string) => void;
}

/**
 * ButtonArea component props
 */
export interface ButtonAreaProps {
  /** Whether submit disabled */
  disabled?: boolean;
  /** Whether has input content */
  hasInputContent?: boolean;
  /** Whether in conversation */
  isLoading?: boolean;
  /** Whether enhancing prompt */
  isEnhancing?: boolean;
  /** Current model */
  selectedModel?: string;
  /** Current mode */
  permissionMode?: PermissionMode;
  /** Current provider */
  currentProvider?: string;
  /** Current reasoning effort (Codex only) */
  reasoningEffort?: ReasoningEffort;

  // Event callbacks
  onSubmit?: () => void;
  onStop?: () => void;
  onModeSelect?: (mode: PermissionMode) => void;
  onModelSelect?: (modelId: string) => void;
  onProviderSelect?: (providerId: string) => void;
  /** Switch reasoning effort callback (Codex only) */
  onReasoningChange?: (effort: ReasoningEffort) => void;
  /** Enhance prompt callback */
  onEnhancePrompt?: () => void;
  /** Whether always thinking enabled */
  alwaysThinkingEnabled?: boolean;
  /** Toggle thinking mode */
  onToggleThinking?: (enabled: boolean) => void;
  /** Whether streaming enabled */
  streamingEnabled?: boolean;
  /** Toggle streaming */
  onStreamingEnabledChange?: (enabled: boolean) => void;
  /** Currently selected agent */
  selectedAgent?: SelectedAgent | null;
  /** Agent selection callback */
  onAgentSelect?: (agent: SelectedAgent) => void;
  /** Clear agent callback */
  onClearAgent?: () => void;
  /** Open agent settings callback */
  onOpenAgentSettings?: () => void;
}

/**
 * Dropdown component props
 */
export interface DropdownProps {
  /** Whether visible */
  isVisible: boolean;
  /** Position information */
  position: DropdownPosition | null;
  /** Width */
  width?: number;
  /** Y offset */
  offsetY?: number;
  /** X offset */
  offsetX?: number;
  /** Selected index */
  selectedIndex?: number;
  /** Close callback */
  onClose?: () => void;
  /** Children */
  children: React.ReactNode;
}

/**
 * TokenIndicator component props
 */
export interface TokenIndicatorProps {
  /** Percentage (0-100) */
  percentage: number;
  /** Size */
  size?: number;
  /** Used context tokens */
  usedTokens?: number;
  /** Maximum context tokens */
  maxTokens?: number;
}

/**
 * AttachmentList component props
 */
export interface AttachmentListProps {
  /** Attachment list */
  attachments: Attachment[];
  /** Remove attachment callback */
  onRemove?: (id: string) => void;
  /** Preview image callback */
  onPreview?: (attachment: Attachment) => void;
}

/**
 * DropdownItem component props
 */
export interface DropdownItemProps {
  /** Item data */
  item: DropdownItemData;
  /** Whether highlighted */
  isActive?: boolean;
  /** Click callback */
  onClick?: () => void;
  /** Mouse enter callback */
  onMouseEnter?: () => void;
}

// ============================================================
// Message Queue Types
// ============================================================

/**
 * Queued message item
 * When AI is processing (loading), new messages are queued here
 */
export interface QueuedMessage {
  /** Unique identifier */
  id: string;
  /** Message content */
  content: string;
  /** Attachments (optional) */
  attachments?: Attachment[];
  /** Timestamp when queued */
  queuedAt: number;
}
