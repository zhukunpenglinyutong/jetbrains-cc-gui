import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type {
  ChatInputBoxHandle,
  ChatInputBoxProps,
  PermissionMode,
} from '../types.js';
import { DEFAULT_CLAUDE_MODEL_ID } from '../types.js';
import {
  useOpenSourceBannerState,
  useChatInputAttachmentsCoordinator,
  useResetAttachmentsOnSessionChange,
  useTooltip,
  useSubmitHandler,
  usePromptEnhancer,
  useChatInputSelectionController,
  useKeyboardHandler,
  useControlledValueSync,
  useNativeEventCapture,
  usePasteAndDrop,
  useGlobalCallbacks,
  useResizableChatInputBox,
} from './index.js';
import { useChatInputTextPipeline } from './useChatInputTextPipeline.js';
import { SessionContext } from '../../../contexts/SessionContext.js';
import { useUIState } from '../../../contexts/UIStateContext.js';
import { useContextMenu } from '../../../hooks/useContextMenu.js';

interface UseChatInputControllerOptions
  extends Pick<
    ChatInputBoxProps,
    | 'attachments'
    | 'value'
    | 'onSubmit'
    | 'onInput'
    | 'onAddAttachment'
    | 'onRemoveAttachment'
    | 'onModeSelect'
    | 'onModelSelect'
    | 'onClearContext'
    | 'onAutoOpenFileEnabledChange'
    | 'onInstallSdk'
    | 'addToast'
    | 'onAgentSelect'
    | 'onOpenAgentSettings'
    | 'onOpenPromptSettings'
  > {
  isLoading: boolean;
  selectedModel: string;
  currentProvider: string;
  sendShortcut: 'enter' | 'cmdEnter';
  sdkInstalled: boolean;
  sdkStatusLoading: boolean;
  t: TFunction;
  ref: React.ForwardedRef<ChatInputBoxHandle>;
}

/**
 * useChatInputController - State/logic controller for ChatInputBox.
 *
 * Composes the attachments coordinator, session-change reset, text pipeline,
 * submit/enhancer/selection/keyboard/paste hooks and the resizable container,
 * returning everything the ChatInputBox JSX needs. Extracted verbatim from the
 * component body to keep ChatInputBox under size limits; behavior is unchanged.
 */
export function useChatInputController({
  isLoading = false,
  selectedModel = DEFAULT_CLAUDE_MODEL_ID,
  currentProvider = 'claude',
  attachments: externalAttachments,
  value,
  onSubmit,
  onInput,
  onAddAttachment,
  onRemoveAttachment,
  onModeSelect,
  onModelSelect,
  onClearContext,
  onAutoOpenFileEnabledChange,
  sendShortcut = 'enter',
  sdkInstalled = true,
  sdkStatusLoading = false,
  onInstallSdk,
  addToast,
  onAgentSelect,
  onOpenAgentSettings,
  onOpenPromptSettings,
  t,
  ref,
}: UseChatInputControllerOptions) {
  const { setSettingsInitialTab, setCurrentView } = useUIState();

  const { showOpenSourceBanner, handleDismissOpenSourceBanner } = useOpenSourceBannerState();
  const {
    attachments,
    setInternalAttachments,
    clearAttachmentsDraft,
    handleAddAttachment,
    handleRemoveAttachment,
  } = useChatInputAttachmentsCoordinator({
    externalAttachments,
    onAddAttachment,
    onRemoveAttachment,
  });

  // Reset draft attachments + clear JCEF ghosting when the session changes, so
  // attachments don't drift into a new conversation and leave stale thumbnails.
  // SessionContext is read null-safely so this component still mounts in tests
  // without a SessionProvider.
  const sessionCtx = useContext(SessionContext);
  const clearInternalAttachments = useCallback(() => {
    setInternalAttachments([]);
    clearAttachmentsDraft?.();
  }, [setInternalAttachments, clearAttachmentsDraft]);
  useResetAttachmentsOnSessionChange({
    currentSessionId: sessionCtx?.currentSessionId ?? null,
    isControlled: externalAttachments !== undefined,
    clearInternalAttachments,
  });

  // Input element refs and state
  const containerRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const editableWrapperRef = useRef<HTMLDivElement>(null);
  const submittedOnEnterRef = useRef(false);
  const completionSelectedRef = useRef(false);
  const [hasContent, setHasContent] = useState(false);

  // Flag to track if we're updating from external value
  const isExternalUpdateRef = useRef(false);

  const {
    getTextContent,
    invalidateCache,
    pathMappingRef,
    extractFileTags,
    renderQuoteTags,
    renderTagsNowIfSafe,
    clearInput,
    adjustHeight,
    closeAllCompletions,
    debouncedOnInput,
    handleInput,
    isComposingRef,
    lastCompositionEndTimeRef,
    handleCompositionStart,
    handleCompositionEnd,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    inlineCompletion,
    recordInputHistory,
    handleHistoryKeyDown,
    handleMacCursorMovement,
  } = useChatInputTextPipeline({
    editableRef,
    isExternalUpdateRef,
    setHasContent,
    onInput,
    currentProvider,
    onAgentSelect,
    onOpenAgentSettings,
    onOpenPromptSettings,
  });

  // Tooltip hook
  const { tooltip, handleMouseOver, handleMouseLeave } = useTooltip({
    containerRef: editableRef,
  });

  // Context menu hook
  const ctxMenu = useContextMenu();

  const handleSubmit = useSubmitHandler({
    getTextContent,
    invalidateCache,
    attachments,
    isLoading,
    sdkStatusLoading,
    sdkInstalled,
    currentProvider,
    clearInput,
    cancelPendingInput: () => {
      debouncedOnInput.cancel();
    },
    externalAttachments,
    setInternalAttachments,
    clearAttachmentsDraft,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    recordInputHistory,
    onSubmit,
    onInstallSdk,
    addToast,
    t,
  });

  // Prompt enhancer hook
  const {
    isEnhancing,
    showEnhancerDialog,
    originalPrompt,
    enhancedPrompt,
    usageInfo,
    handleEnhancePrompt,
    handleUseEnhancedPrompt,
    handleKeepOriginalPrompt,
    handleCloseEnhancerDialog,
  } = usePromptEnhancer({
    editableRef,
    getTextContent,
    setHasContent,
    onInput,
    currentProvider,
    selectedModel,
  });

  const handleOpenPromptEnhancerSettings = useCallback(() => {
    handleCloseEnhancerDialog();
    setSettingsInitialTab('promptEnhancer');
    setCurrentView('settings');
  }, [handleCloseEnhancerDialog, setSettingsInitialTab, setCurrentView]);

  const {
    focusInput,
    applyInlineCompletion,
    handleCtxMenuCut,
    handleClearFileContext,
    handleRequestEnableFileContext,
  } = useChatInputSelectionController({
    ref,
    editableRef,
    getTextContent,
    invalidateCache,
    isExternalUpdateRef,
    setHasContent,
    adjustHeight,
    clearInput,
    hasContent,
    extractFileTags,
    inlineCompletion,
    handleInput,
    ctxMenu,
    onClearContext,
    onAutoOpenFileEnabledChange,
  });

  const { onKeyDown: handleKeyDown, onKeyUp: handleKeyUp } = useKeyboardHandler({
    isComposingRef,
    lastCompositionEndTimeRef,
    sendShortcut,
    sdkStatusLoading,
    sdkInstalled,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    handleMacCursorMovement,
    handleHistoryKeyDown,
    // Inline completion: Tab key applies suggestion
    inlineCompletion: inlineCompletion.hasSuggestion ? {
      applySuggestion: applyInlineCompletion,
    } : undefined,
    completionSelectedRef,
    submittedOnEnterRef,
    handleSubmit,
  });

  useControlledValueSync({
    value,
    editableRef,
    isComposingRef,
    isExternalUpdateRef,
    getTextContent,
    setHasContent,
    adjustHeight,
    invalidateCache,
  });

  useNativeEventCapture({
    editableRef,
    isComposingRef,
    lastCompositionEndTimeRef,
    sendShortcut,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    completionSelectedRef,
    submittedOnEnterRef,
    handleSubmit,
    handleEnhancePrompt,
  });

  // Listen for IDEA shortcut send event (dispatched by window.execContextAction)
  useEffect(() => {
    const handler = () => {
      if (!isLoading && !isComposingRef.current) {
        handleSubmit();
      }
    };
    document.addEventListener('ideaSend', handler);
    return () => document.removeEventListener('ideaSend', handler);
  }, [handleSubmit, isLoading]);

  // Paste and drop hook
  const { handlePaste, handleDragOver, handleDrop } = usePasteAndDrop({
    editableRef,
    pathMappingRef,
    getTextContent,
    adjustHeight,
    renderFileTags: renderTagsNowIfSafe,
    setHasContent,
    setInternalAttachments,
    onInput,
    closeAllCompletions,
    handleInput,
    flushInput: () => {
      debouncedOnInput.flush();
    },
  });

  /**
   * Handle mode select
   */
  const handleModeSelect = useCallback(
    (mode: PermissionMode) => {
      onModeSelect?.(mode);
    },
    [onModeSelect]
  );

  /**
   * Handle model select
   */
  const handleModelSelect = useCallback(
    (modelId: string) => {
      onModelSelect?.(modelId);
    },
    [onModelSelect]
  );

  // Global callbacks hook
  useGlobalCallbacks({
    editableRef,
    pathMappingRef,
    getTextContent,
    adjustHeight,
    renderFileTags: renderTagsNowIfSafe,
    renderQuoteTags,
    setHasContent,
    onInput,
    closeAllCompletions,
    focusInput,
  });

  const {
    isResizing: isResizingInputBox,
    containerStyle,
    editableWrapperStyle,
    getHandleProps,
    nudge,
  } = useResizableChatInputBox({
    containerRef,
    editableWrapperRef,
  });

  // Whether any completion menu is open (drives Enter/submit suppression in the
  // input area's beforeinput handler).
  const anyCompletionOpen =
    fileCompletion.isOpen ||
    commandCompletion.isOpen ||
    agentCompletion.isOpen ||
    promptCompletion.isOpen ||
    dollarCommandCompletion.isOpen;

  const promptEnhancer = {
    isOpen: showEnhancerDialog,
    isLoading: isEnhancing,
    originalPrompt,
    enhancedPrompt,
    usageInfo,
    onUseEnhanced: handleUseEnhancedPrompt,
    onKeepOriginal: handleKeepOriginalPrompt,
    onClose: handleCloseEnhancerDialog,
    onOpenSettings: handleOpenPromptEnhancerSettings,
  };

  return {
    attachments,
    handleAddAttachment,
    handleRemoveAttachment,
    showOpenSourceBanner,
    handleDismissOpenSourceBanner,
    containerRef,
    editableRef,
    editableWrapperRef,
    isResizingInputBox,
    containerStyle,
    editableWrapperStyle,
    getHandleProps,
    nudge,
    focusInput,
    handleMouseOver,
    handleMouseLeave,
    hasContent,
    handleInput,
    handleKeyDown,
    handleKeyUp,
    completionSelectedRef,
    isComposingRef,
    anyCompletionOpen,
    handleSubmit,
    handleCompositionStart,
    handleCompositionEnd,
    handlePaste,
    handleDragOver,
    handleDrop,
    ctxMenu,
    handleCtxMenuCut,
    handleClearFileContext,
    handleRequestEnableFileContext,
    isEnhancing,
    handleEnhancePrompt,
    promptEnhancer,
    handleModeSelect,
    handleModelSelect,
    inlineCompletion,
    tooltip,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
  };
}
