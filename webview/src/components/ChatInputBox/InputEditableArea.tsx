import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  RefObject,
} from 'react';
import type { TFunction } from 'i18next';
import { ContextMenu } from '../ContextMenu';
import {
  copySelection,
  insertNewline,
  pasteAtCursor,
} from '../../hooks/useContextMenu.js';
/** Shape of the context-menu state/handlers used by this component. */
interface InputContextMenu {
  visible: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
  savedRange: Range | null;
  selectedText: string;
  open: (e: ReactMouseEvent) => void;
  close: () => void;
}

interface InputEditableAreaProps {
  editableWrapperRef: RefObject<HTMLDivElement | null>;
  editableWrapperStyle: CSSProperties;
  editableRef: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  placeholder: string;
  completionSuffix: string;
  handleInput: (inputType?: string) => void;
  handleKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  handleKeyUp: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  completionSelectedRef: MutableRefObject<boolean>;
  /** Whether any completion menu is open (Enter selects instead of submitting) */
  anyCompletionOpen: boolean;
  isLoading: boolean;
  isComposingRef: MutableRefObject<boolean>;
  onSubmit: () => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  handlePaste: (e: React.ClipboardEvent) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
  ctxMenu: InputContextMenu;
  onCut: () => void;
  t: TFunction;
}

/**
 * InputEditableArea - The contenteditable input region of ChatInputBox.
 *
 * Renders the editable div (with IME-safe input/beforeinput wiring) plus the
 * right-click context menu overlay. Pure extraction from ChatInputBox; all
 * state and handlers are owned by the parent and passed in as props.
 */
export function InputEditableArea({
  editableWrapperRef,
  editableWrapperStyle,
  editableRef,
  disabled,
  placeholder,
  completionSuffix,
  handleInput,
  handleKeyDown,
  handleKeyUp,
  completionSelectedRef,
  anyCompletionOpen,
  isLoading,
  isComposingRef,
  onSubmit,
  handleCompositionStart,
  handleCompositionEnd,
  handlePaste,
  handleDragOver,
  handleDrop,
  ctxMenu,
  onCut,
  t,
}: InputEditableAreaProps) {
  return (
    <div
      ref={editableWrapperRef}
      className="input-editable-wrapper"
      style={editableWrapperStyle}
    >
      <div
        ref={editableRef}
        className="input-editable"
        contentEditable={!disabled}
        spellCheck={false}
        data-placeholder={placeholder}
        data-completion-suffix={completionSuffix}
        onInput={(e) => {
          // Don't pass browser's isComposing — it's unreliable in JCEF.
          // isComposingRef (set by compositionStart/End + keyCode 229) is the
          // sole source of truth for IME state. The inputType is forwarded so
          // handleInput can detect a stale composing flag (lost compositionEnd).
          const inputType =
            'inputType' in e.nativeEvent
              ? (e.nativeEvent as InputEvent).inputType
              : undefined;
          handleInput(inputType);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBeforeInput={(e) => {
          const inputType =
            'inputType' in e.nativeEvent
              ? (e.nativeEvent as InputEvent).inputType
              : undefined;
          if (inputType === 'insertParagraph') {
            e.preventDefault();
            // If item was just selected in completion menu with enter, don't send message
            if (completionSelectedRef.current) {
              completionSelectedRef.current = false;
              return;
            }
            // Don't send message when completion menu is open
            if (anyCompletionOpen) {
              return;
            }
            // Only allow submit when not loading and not in IME composition
            if (!isLoading && !isComposingRef.current) {
              onSubmit();
            }
          }
          // Fix: Remove delete key special handling during IME
          // Let browser naturally handle delete operations, sync state uniformly after compositionend
        }}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onContextMenu={ctxMenu.open}
        suppressContentEditableWarning
      />
      {ctxMenu.visible && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={ctxMenu.close}
          items={[
            { label: t('contextMenu.copy', 'Copy'), action: () => copySelection(ctxMenu.savedRange, ctxMenu.selectedText), disabled: !ctxMenu.hasSelection },
            { label: t('contextMenu.cut', 'Cut'), action: onCut, disabled: !ctxMenu.hasSelection },
            { label: t('contextMenu.paste', 'Paste'), action: () => { if (editableRef.current) { pasteAtCursor(ctxMenu.savedRange, editableRef.current, handleInput); } } },
            { separator: true },
            { label: t('contextMenu.newline', 'Insert Newline'), action: () => { if (editableRef.current) { insertNewline(ctxMenu.savedRange, editableRef.current); handleInput(); } } },
          ]}
        />
      )}
    </div>
  );
}

export default InputEditableArea;
