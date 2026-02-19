/**
 * ChatInputBox component module exports
 * Feature: 004-refactor-input-box
 */

export { ChatInputBox, default } from './ChatInputBox';
export { ButtonArea } from './ButtonArea';
export { TokenIndicator } from './TokenIndicator';
export { AttachmentList } from './AttachmentList';
export { ModeSelect, ModelSelect } from './selectors';

// Export types
export type {
  Attachment,
  ChatInputBoxHandle,
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

// Export constants
export {
  AVAILABLE_MODES,
  AVAILABLE_MODELS,
  IMAGE_MEDIA_TYPES,
  isImageAttachment,
} from './types';
