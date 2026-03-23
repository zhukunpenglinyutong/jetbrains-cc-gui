import { useCallback } from 'react';
import type { ForwardedRef, MutableRefObject, RefObject } from 'react';
import { cutSelection } from '../../../hooks/useContextMenu.js';
import type { ChatInputBoxHandle, FileTagInfo } from '../types.js';
import { useChatInputImperativeHandle } from './useChatInputImperativeHandle.js';

interface InlineCompletionController {
  applySuggestion: () => string | null;
}

interface ContextMenuSelectionState {
  savedRange: Range | null;
  selectedText: string;
  targetFileTag?: HTMLElement | null;
}

interface UseChatInputSelectionControllerOptions {
  ref: ForwardedRef<ChatInputBoxHandle>;
  editableRef: RefObject<HTMLDivElement | null>;
  getTextContent: () => string;
  invalidateCache: () => void;
  isExternalUpdateRef: MutableRefObject<boolean>;
  setHasContent: (hasContent: boolean) => void;
  adjustHeight: () => void;
  clearInput: () => void;
  hasContent: boolean;
  extractFileTags: () => FileTagInfo[];
  inlineCompletion: InlineCompletionController;
  handleInput: () => void;
  ctxMenu: ContextMenuSelectionState;
  onClearContext?: () => void;
  onAutoOpenFileEnabledChange?: (enabled: boolean) => void;
}

export function useChatInputSelectionController({
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
}: UseChatInputSelectionControllerOptions) {
  const focusInput = useCallback(() => {
    editableRef.current?.focus();
  }, [editableRef]);

  const applyInlineCompletion = useCallback(() => {
    const fullText = inlineCompletion.applySuggestion();
    if (!fullText || !editableRef.current) return false;

    editableRef.current.innerText = fullText;

    const range = document.createRange();
    const selection = window.getSelection();
    range.selectNodeContents(editableRef.current);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);

    handleInput();
    return true;
  }, [editableRef, handleInput, inlineCompletion]);

  const handleCtxMenuCut = useCallback(() => {
    if (!editableRef.current) return;
    cutSelection(ctxMenu.savedRange, ctxMenu.selectedText, editableRef.current, ctxMenu.targetFileTag);
    handleInput();
  }, [ctxMenu.savedRange, ctxMenu.selectedText, ctxMenu.targetFileTag, editableRef, handleInput]);

  const handleClearFileContext = useCallback(() => {
    onClearContext?.();
    onAutoOpenFileEnabledChange?.(false);
  }, [onClearContext, onAutoOpenFileEnabledChange]);

  const handleRequestEnableFileContext = useCallback(() => {
    onAutoOpenFileEnabledChange?.(true);
  }, [onAutoOpenFileEnabledChange]);

  useChatInputImperativeHandle({
    ref,
    editableRef,
    getTextContent,
    invalidateCache,
    isExternalUpdateRef,
    setHasContent,
    adjustHeight,
    focusInput,
    clearInput,
    hasContent,
    extractFileTags,
  });

  return {
    focusInput,
    applyInlineCompletion,
    handleCtxMenuCut,
    handleClearFileContext,
    handleRequestEnableFileContext,
  };
}
