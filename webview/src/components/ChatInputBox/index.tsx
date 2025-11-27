/**
 * ChatInputBox 组件模块导出
 * 功能: 004-refactor-input-box
 */

export { ChatInputBox, default } from './ChatInputBox';
export { ButtonArea } from './ButtonArea';
export { TokenIndicator } from './TokenIndicator';
export { AttachmentList } from './AttachmentList';
export { ModeSelect, ModelSelect } from './selectors';

// 导出类型
export type {
  Attachment,
  ChatInputBoxProps,
  ButtonAreaProps,
  TokenIndicatorProps,
  AttachmentListProps,
  PermissionMode,
  DropdownItemData,
  DropdownPosition,
  TriggerQuery,
  FileItem,
  CommandItem,
  CompletionType,
} from './types';

// 导出常量
export {
  AVAILABLE_MODES,
  AVAILABLE_MODELS,
  IMAGE_MEDIA_TYPES,
  isImageAttachment,
} from './types';
