import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  Attachment,
  ChatInputBoxHandle,
  ChatInputBoxProps,
  CommandItem,
  FileItem,
  PermissionMode,
} from './types.js';
import { ButtonArea } from './ButtonArea.js';
import { AttachmentList } from './AttachmentList.js';
import { ContextBar } from './ContextBar.js';
import { CompletionDropdown } from './Dropdown/index.js';
import { PromptEnhancerDialog } from './PromptEnhancerDialog.js';
import {
  useCompletionDropdown,
  useTriggerDetection,
  useTextContent,
  useFileTags,
  useTooltip,
  useKeyboardNavigation,
  useIMEComposition,
  usePasteAndDrop,
  usePromptEnhancer,
  useGlobalCallbacks,
} from './hooks/index.js';
import {
  commandToDropdownItem,
  fileReferenceProvider,
  fileToDropdownItem,
  slashCommandProvider,
  agentProvider,
  agentToDropdownItem,
  type AgentItem,
} from './providers/index.js';
import { debounce } from './utils/debounce.js';
import { generateId } from './utils/generateId.js';
import './styles.css';

/**
 * ChatInputBox - Chat input component
 * Uses contenteditable div with auto height adjustment, IME handling, @ file references, / slash commands
 *
 * Performance optimizations:
 * - Uses uncontrolled mode with useImperativeHandle for minimal re-renders
 * - Debounced onInput callback to reduce parent component updates
 * - Cached getTextContent to avoid repeated DOM traversal
 */
export const ChatInputBox = forwardRef<ChatInputBoxHandle, ChatInputBoxProps>(
  (
    {
      isLoading = false,
      selectedModel = 'claude-sonnet-4-5',
      permissionMode = 'bypassPermissions',
      currentProvider = 'claude',
      usagePercentage = 0,
      usageUsedTokens,
      usageMaxTokens,
      showUsage = true,
      attachments: externalAttachments,
      placeholder = '', // Will be passed from parent via t('chat.inputPlaceholder')
      disabled = false,
      value,
      onSubmit,
      onStop,
      onInput,
      onAddAttachment,
      onRemoveAttachment,
      onModeSelect,
      onModelSelect,
      onProviderSelect,
      reasoningEffort = 'medium',
      onReasoningChange,
      activeFile,
      selectedLines,
      onClearContext,
      alwaysThinkingEnabled,
      onToggleThinking,
      streamingEnabled,
      onStreamingEnabledChange,
      sendShortcut = 'enter',
      selectedAgent,
      onAgentSelect,
      onOpenAgentSettings,
      hasMessages,
      onRewind,
      sdkInstalled = true, // Default to true to avoid disabling input box on initial state
      sdkStatusLoading = false, // SDK status loading state
      onInstallSdk,
      addToast,
    }: ChatInputBoxProps,
    ref: React.ForwardedRef<ChatInputBoxHandle>
  ) => {
    const { t } = useTranslation();

    // Internal attachments state (if not provided externally)
    const [internalAttachments, setInternalAttachments] = useState<Attachment[]>([]);
    const attachments = externalAttachments ?? internalAttachments;

    // Input element refs and state
    const containerRef = useRef<HTMLDivElement>(null);
    const editableRef = useRef<HTMLDivElement>(null);
    const submittedOnEnterRef = useRef(false);
    const completionSelectedRef = useRef(false);
    const [hasContent, setHasContent] = useState(false);

    // Flag to track if we're updating from external value
    const isExternalUpdateRef = useRef(false);

    // Text content hook
    const { getTextContent, invalidateCache } = useTextContent({ editableRef });

    // Trigger detection hook
    const { detectTrigger, getTriggerPosition, getCursorPosition } = useTriggerDetection();

    // Close all completions helper
    const closeAllCompletions = useCallback(() => {
      fileCompletion.close();
      commandCompletion.close();
      agentCompletion.close();
    }, []);

    // File tags hook
    const { renderFileTags, pathMappingRef, justRenderedTagRef, extractFileTags } = useFileTags({
      editableRef,
      getTextContent,
      onCloseCompletions: closeAllCompletions,
    });

    // File reference completion hook
    const fileCompletion = useCompletionDropdown<FileItem>({
      trigger: '@',
      provider: fileReferenceProvider,
      toDropdownItem: fileToDropdownItem,
      onSelect: (file, query) => {
        if (!editableRef.current || !query) return;

        const text = getTextContent();
        // Prefer absolute path, fallback to relative path
        const path = file.absolutePath || file.path;
        // Directories don't add space (to continue path input), files add space
        const replacement = file.type === 'directory' ? `@${path}` : `@${path} `;
        const newText = fileCompletion.replaceText(text, replacement, query);

        // Record path mapping: filename -> full path, for tooltip display
        if (file.absolutePath) {
          // Record multiple possible keys: filename, relative path, absolute path
          pathMappingRef.current.set(file.name, file.absolutePath);
          pathMappingRef.current.set(file.path, file.absolutePath);
          pathMappingRef.current.set(file.absolutePath, file.absolutePath);
        }

        // Update input box content
        editableRef.current.innerText = newText;

        // Set cursor to end of inserted text
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(editableRef.current);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);

        handleInput();

        // Immediately try to render file tags (no need for user to manually input space)
        // Use setTimeout to ensure DOM update and cursor position are ready
        setTimeout(() => {
          renderFileTags();
        }, 0);
      },
    });

    // Slash command completion hook
    const commandCompletion = useCompletionDropdown<CommandItem>({
      trigger: '/',
      provider: slashCommandProvider,
      toDropdownItem: commandToDropdownItem,
      onSelect: (command, query) => {
        if (!editableRef.current || !query) return;

        const text = getTextContent();
        const replacement = `${command.label} `;
        const newText = commandCompletion.replaceText(text, replacement, query);

        // Update input box content
        editableRef.current.innerText = newText;

        // Set cursor to end of inserted text
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(editableRef.current);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);

        handleInput();
      },
    });

    // Agent selection completion hook (# trigger at line start)
    const agentCompletion = useCompletionDropdown<AgentItem>({
      trigger: '#',
      provider: agentProvider,
      toDropdownItem: agentToDropdownItem,
      onSelect: (agent, query) => {
        // Skip loading and empty state special items
        if (
          agent.id === '__loading__' ||
          agent.id === '__empty__' ||
          agent.id === '__empty_state__'
        )
          return;

        // Handle create agent
        if (agent.id === '__create_new__') {
          onOpenAgentSettings?.();
          // Clear # trigger text from input box
          if (editableRef.current && query) {
            const text = getTextContent();
            const newText = agentCompletion.replaceText(text, '', query);
            editableRef.current.innerText = newText;

            const range = document.createRange();
            const selection = window.getSelection();
            range.selectNodeContents(editableRef.current);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);

            handleInput();
          }
          return;
        }

        // Select agent: don't insert text, call onAgentSelect callback
        onAgentSelect?.({ id: agent.id, name: agent.name, prompt: agent.prompt });

        // Clear # trigger text from input box
        if (editableRef.current && query) {
          const text = getTextContent();
          const newText = agentCompletion.replaceText(text, '', query);
          editableRef.current.innerText = newText;

          // Set cursor position
          const range = document.createRange();
          const selection = window.getSelection();
          range.selectNodeContents(editableRef.current);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);

          handleInput();
        }
      },
    });

    // Tooltip hook
    const { tooltip, handleMouseOver, handleMouseLeave } = useTooltip();

    /**
     * Clear input box
     */
    const clearInput = useCallback(() => {
      if (editableRef.current) {
        editableRef.current.innerHTML = '';
        editableRef.current.style.height = 'auto';
        setHasContent(false);
        // Notify parent component that input is cleared
        onInput?.('');
      }
    }, [onInput]);

    /**
     * Adjust input box height
     * Let contenteditable element expand naturally (height: auto),
     * outer container (.input-editable-wrapper) controls scrolling via max-height and overflow-y.
     * This avoids double scrollbar issue from outer + inner element scrolling.
     */
    const adjustHeight = useCallback(() => {
      const el = editableRef.current;
      if (!el) return;

      // Ensure height is auto, expanded by content
      el.style.height = 'auto';
      // Hide inner scrollbar, completely rely on outer container scrolling
      el.style.overflowY = 'hidden';
    }, []);

    /**
     * Detect and handle completion triggers (optimized: only start detection when @ or / or # is input)
     */
    const detectAndTriggerCompletion = useCallback(() => {
      if (!editableRef.current) return;

      // Don't detect completion during IME composition to avoid interfering with composition
      if (isComposing) {
        return;
      }

      // If file tags were just rendered, skip this completion detection
      if (justRenderedTagRef.current) {
        justRenderedTagRef.current = false;
        fileCompletion.close();
        commandCompletion.close();
        agentCompletion.close();
        return;
      }

      const text = getTextContent();
      const cursorPos = getCursorPosition(editableRef.current);

      // Optimization: Quick check if text contains trigger characters, return immediately if not
      const hasAtSymbol = text.includes('@');
      const hasSlashSymbol = text.includes('/');
      const hasHashSymbol = text.includes('#');

      if (!hasAtSymbol && !hasSlashSymbol && !hasHashSymbol) {
        fileCompletion.close();
        commandCompletion.close();
        agentCompletion.close();
        return;
      }

      // Pass element parameter so detectTrigger can skip file tags
      const trigger = detectTrigger(text, cursorPos, editableRef.current);

      // Close currently open completion
      if (!trigger) {
        fileCompletion.close();
        commandCompletion.close();
        agentCompletion.close();
        return;
      }

      // Get trigger position
      const position = getTriggerPosition(editableRef.current, trigger.start);
      if (!position) return;

      // Open corresponding completion based on trigger symbol
      if (trigger.trigger === '@') {
        commandCompletion.close();
        agentCompletion.close();
        if (!fileCompletion.isOpen) {
          fileCompletion.open(position, trigger);
          fileCompletion.updateQuery(trigger);
        } else {
          fileCompletion.updateQuery(trigger);
        }
      } else if (trigger.trigger === '/') {
        fileCompletion.close();
        agentCompletion.close();
        if (!commandCompletion.isOpen) {
          commandCompletion.open(position, trigger);
          commandCompletion.updateQuery(trigger);
        } else {
          commandCompletion.updateQuery(trigger);
        }
      } else if (trigger.trigger === '#') {
        fileCompletion.close();
        commandCompletion.close();
        if (!agentCompletion.isOpen) {
          agentCompletion.open(position, trigger);
          agentCompletion.updateQuery(trigger);
        } else {
          agentCompletion.updateQuery(trigger);
        }
      }
    }, [
      getTextContent,
      getCursorPosition,
      detectTrigger,
      getTriggerPosition,
      fileCompletion,
      commandCompletion,
      agentCompletion,
    ]);

    // Create debounced version of renderFileTags (300ms delay)
    const debouncedRenderFileTags = useMemo(
      () => debounce(renderFileTags, 300),
      [renderFileTags]
    );

    // Create debounced version of detectAndTriggerCompletion (150ms delay)
    const debouncedDetectCompletion = useMemo(
      () => debounce(detectAndTriggerCompletion, 150),
      [detectAndTriggerCompletion]
    );

    // Performance optimization: Debounced onInput callback
    // Reduces parent component re-renders during rapid typing
    const debouncedOnInput = useMemo(
      () =>
        debounce((text: string) => {
          // Skip if this is an external value update to avoid loops
          if (isExternalUpdateRef.current) {
            isExternalUpdateRef.current = false;
            return;
          }
          onInput?.(text);
        }, 100),
      [onInput]
    );

    /**
     * Handle input event (optimized: use debounce to reduce performance overhead)
     * @param isComposingFromEvent - isComposing state from native event (higher priority)
     */
    const handleInput = useCallback(
      (isComposingFromEvent?: boolean) => {
        // Use multiple checks to correctly detect IME state:
        // 1. Native event isComposing (most accurate, can detect before compositionStart)
        // 2. isComposingRef (sync ref, faster than React state)
        // 3. React state isComposing (as fallback)
        const isCurrentlyComposing =
          isComposingFromEvent ?? isComposingRef.current ?? isComposing;

        // Key fix: During IME composition, completely skip all DOM operations and state updates
        // Avoid interrupting IME normal operation, wait for compositionend to handle uniformly
        if (isCurrentlyComposing) {
          return;
        }

        // Invalidate cache since content changed
        invalidateCache();

        const text = getTextContent();
        // Remove zero-width and other invisible characters before checking if empty, ensure placeholder shows when only zero-width characters remain
        const cleanText = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
        const isEmpty = !cleanText.trim();

        // If content is empty, clear innerHTML to ensure :empty pseudo-class works (show placeholder)
        if (isEmpty && editableRef.current) {
          editableRef.current.innerHTML = '';
        }

        // Adjust height
        adjustHeight();

        // Trigger completion detection and state update
        debouncedDetectCompletion();
        setHasContent(!isEmpty);

        // Notify parent component (use debounced version to reduce re-renders)
        // If determined empty (only zero-width characters), pass empty string to parent
        debouncedOnInput(isEmpty ? '' : text);
      },
      [
        getTextContent,
        adjustHeight,
        debouncedDetectCompletion,
        debouncedOnInput,
        invalidateCache,
      ]
    );

    // IME composition hook
    const {
      isComposing,
      isComposingRef,
      lastCompositionEndTimeRef,
      handleCompositionStart,
      handleCompositionEnd,
    } = useIMEComposition({
      handleInput,
      renderFileTags,
    });

    // Keyboard navigation hook
    const { handleMacCursorMovement } = useKeyboardNavigation({
      editableRef,
      handleInput,
    });

    /**
     * Handle keyboard down event (for detecting space to trigger file tag rendering)
     * Optimized: use debounce for delayed rendering
     */
    const handleKeyDownForTagRendering = useCallback(
      (e: KeyboardEvent) => {
        // If space key pressed, use debounce for delayed file tag rendering
        if (e.key === ' ') {
          debouncedRenderFileTags();
        }
      },
      [debouncedRenderFileTags]
    );

    /**
     * Handle submit
     * Preserve user input original format (spaces, newlines, indentation, etc.)
     */
    const handleSubmit = useCallback(() => {
      const content = getTextContent();
      // Remove zero-width spaces and other invisible characters
      const cleanContent = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

      if (sdkStatusLoading) {
        // SDK status loading, don't allow sending
        addToast?.(t('chat.sdkStatusLoading'), 'info');
        return;
      }

      if (!sdkInstalled) {
        // Prompt user to download dependency package
        addToast?.(
          t('chat.sdkNotInstalled', {
            provider: currentProvider === 'codex' ? 'Codex' : 'Claude Code',
          }) +
            ' ' +
            t('chat.goInstallSdk'),
          'warning'
        );
        onInstallSdk?.();
        return;
      }

      // Only use trim when checking if empty, don't modify actual sent content
      if (!cleanContent && attachments.length === 0) {
        return;
      }
      if (isLoading) {
        return;
      }

      // Close completion menus
      fileCompletion.close();
      commandCompletion.close();
      agentCompletion.close();

      // Capture attachments before clearing
      const attachmentsToSend = attachments.length > 0 ? [...attachments] : undefined;

      // Clear input box immediately for responsiveness
      clearInput();

      // If using internal attachments state, also clear attachments
      if (externalAttachments === undefined) {
        setInternalAttachments([]);
      }

      // Defer the heavy submission logic to allow UI update
      setTimeout(() => {
        onSubmit?.(content, attachmentsToSend);
      }, 10);
    }, [
      getTextContent,
      attachments,
      isLoading,
      onSubmit,
      clearInput,
      externalAttachments,
      fileCompletion,
      commandCompletion,
      agentCompletion,
      sdkStatusLoading,
      sdkInstalled,
      onInstallSdk,
      addToast,
      t,
      currentProvider,
    ]);

    // Prompt enhancer hook
    const {
      isEnhancing,
      showEnhancerDialog,
      originalPrompt,
      enhancedPrompt,
      handleEnhancePrompt,
      handleUseEnhancedPrompt,
      handleKeepOriginalPrompt,
      handleCloseEnhancerDialog,
    } = usePromptEnhancer({
      editableRef,
      getTextContent,
      selectedModel,
      setHasContent,
      onInput,
    });

    /**
     * Handle keyboard events
     */
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        // Detect IME composition state (multiple methods)
        // keyCode 229 is special code during IME input
        // nativeEvent.isComposing is native event composition state
        const isIMEComposing = isComposing || e.nativeEvent.isComposing;

        const isEnterKey =
          e.key === 'Enter' ||
          (e as unknown as { keyCode?: number }).keyCode === 13 ||
          (e.nativeEvent as unknown as { keyCode?: number }).keyCode === 13 ||
          (e as unknown as { which?: number }).which === 13;

        // First handle Mac-style cursor movement and text selection
        if (handleMacCursorMovement(e)) {
          return;
        }

        // Allow other cursor movement shortcuts (Home/End/Ctrl+A/Ctrl+E)
        const isCursorMovementKey =
          e.key === 'Home' ||
          e.key === 'End' ||
          ((e.key === 'a' || e.key === 'A') && e.ctrlKey && !e.metaKey) || // Ctrl+A (Linux/Windows)
          ((e.key === 'e' || e.key === 'E') && e.ctrlKey && !e.metaKey); // Ctrl+E (Linux/Windows)

        if (isCursorMovementKey) {
          // Allow default cursor movement behavior
          return;
        }

        // First handle completion menu keyboard events
        if (fileCompletion.isOpen) {
          const handled = fileCompletion.handleKeyDown(e.nativeEvent);
          if (handled) {
            e.preventDefault();
            e.stopPropagation();
            // If enter key selected, mark to prevent subsequent message sending
            if (e.key === 'Enter') {
              completionSelectedRef.current = true;
            }
            return;
          }
        }

        if (commandCompletion.isOpen) {
          const handled = commandCompletion.handleKeyDown(e.nativeEvent);
          if (handled) {
            e.preventDefault();
            e.stopPropagation();
            // If enter key selected, mark to prevent subsequent message sending
            if (e.key === 'Enter') {
              completionSelectedRef.current = true;
            }
            return;
          }
        }

        if (agentCompletion.isOpen) {
          const handled = agentCompletion.handleKeyDown(e.nativeEvent);
          if (handled) {
            e.preventDefault();
            e.stopPropagation();
            // If enter key selected, mark to prevent subsequent message sending
            if (e.key === 'Enter') {
              completionSelectedRef.current = true;
            }
            return;
          }
        }

        // Check if composition input just ended (prevent IME confirm enter false trigger)
        // If compositionend and keydown interval is very short, this keydown might be IME confirm enter
        const isRecentlyComposing = Date.now() - lastCompositionEndTimeRef.current < 100;

        // Determine send behavior based on sendShortcut setting
        // sendShortcut === 'enter': Enter sends, Shift+Enter newline
        // sendShortcut === 'cmdEnter': Cmd/Ctrl+Enter sends, Enter newline
        const isSendKey =
          sendShortcut === 'cmdEnter'
            ? isEnterKey && (e.metaKey || e.ctrlKey) && !isIMEComposing
            : isEnterKey && !e.shiftKey && !isIMEComposing && !isRecentlyComposing;

        if (isSendKey) {
          e.preventDefault();
          if (sdkStatusLoading || !sdkInstalled) {
            // SDK status loading or not installed, enter doesn't send
            return;
          }
          submittedOnEnterRef.current = true;
          handleSubmit();
          return;
        }

        // For cmdEnter mode, allow normal Enter newline (default behavior)
        // For enter mode, Shift+Enter allows newline (default behavior)
      },
      [
        isComposing,
        handleSubmit,
        fileCompletion,
        commandCompletion,
        agentCompletion,
        sdkStatusLoading,
        sdkInstalled,
        sendShortcut,
        handleMacCursorMovement,
        lastCompositionEndTimeRef,
      ]
    );

    const handleKeyUp = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        const isEnterKey =
          e.key === 'Enter' ||
          (e as unknown as { keyCode?: number }).keyCode === 13 ||
          (e.nativeEvent as unknown as { keyCode?: number }).keyCode === 13 ||
          (e as unknown as { which?: number }).which === 13;

        // Determine if send key based on sendShortcut setting
        const isSendKey =
          sendShortcut === 'cmdEnter'
            ? isEnterKey && (e.metaKey || e.ctrlKey)
            : isEnterKey && !e.shiftKey;

        if (isSendKey) {
          e.preventDefault();
          // If item was just selected in completion menu, don't send message
          if (completionSelectedRef.current) {
            completionSelectedRef.current = false;
            return;
          }
          if (submittedOnEnterRef.current) {
            submittedOnEnterRef.current = false;
            return;
          }
        }
      },
      [sendShortcut]
    );

    // Performance optimization: Simplified controlled mode
    // Only sync external value when it's explicitly different and not from user input
    useEffect(() => {
      // Skip if value prop is not provided (uncontrolled mode)
      if (value === undefined) return;
      if (!editableRef.current) return;

      // Skip during IME composition to avoid breaking input
      if (isComposingRef.current) return;

      // Invalidate cache before comparing
      invalidateCache();
      const currentText = getTextContent();

      // Only update if external value differs from current content
      // This prevents the update loop: user types -> onInput -> parent sets value -> useEffect
      if (currentText !== value) {
        // Mark as external update to prevent debounced onInput from firing
        isExternalUpdateRef.current = true;

        editableRef.current.innerText = value;
        setHasContent(!!value.trim());
        adjustHeight();

        // Move cursor to end
        if (value) {
          const range = document.createRange();
          const selection = window.getSelection();
          range.selectNodeContents(editableRef.current);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }

        // Invalidate cache after update
        invalidateCache();
      }
    }, [value, getTextContent, adjustHeight, invalidateCache, isComposingRef]);

    // Native event capture, compatible with JCEF/IME special behavior
    useEffect(() => {
      const el = editableRef.current;
      if (!el) return;

      const nativeKeyDown = (ev: KeyboardEvent) => {
        // Detect IME input: keyCode 229 means IME is processing key
        // This is earlier than compositionStart event, can set composing state earlier
        const isIMEProcessing =
          (ev as unknown as { keyCode?: number }).keyCode === 229 || ev.isComposing;
        if (isIMEProcessing) {
          isComposingRef.current = true;
        }

        const isEnterKey =
          ev.key === 'Enter' ||
          (ev as unknown as { keyCode?: number }).keyCode === 13 ||
          (ev as unknown as { which?: number }).which === 13;

        // ⌘/ shortcut: enhance prompt
        if (ev.key === '/' && ev.metaKey && !ev.shiftKey && !ev.altKey) {
          ev.preventDefault();
          ev.stopPropagation();
          handleEnhancePrompt();
          return;
        }

        // Mac-style cursor movement shortcuts and delete operations (already handled in React event, not needed here)
        const isMacCursorMovementOrDelete =
          (ev.key === 'ArrowLeft' && ev.metaKey) ||
          (ev.key === 'ArrowRight' && ev.metaKey) ||
          (ev.key === 'ArrowUp' && ev.metaKey) ||
          (ev.key === 'ArrowDown' && ev.metaKey) ||
          (ev.key === 'Backspace' && ev.metaKey);

        if (isMacCursorMovementOrDelete) {
          // Mac shortcuts already handled in React event
          return;
        }

        // Allow other cursor movement shortcuts (Home/End/Ctrl+A/Ctrl+E)
        const isCursorMovementKey =
          ev.key === 'Home' ||
          ev.key === 'End' ||
          ((ev.key === 'a' || ev.key === 'A') && ev.ctrlKey && !ev.metaKey) ||
          ((ev.key === 'e' || ev.key === 'E') && ev.ctrlKey && !ev.metaKey);

        if (isCursorMovementKey) {
          // Allow default cursor movement behavior
          return;
        }

        // When completion menu is open, don't handle in native event (React onKeyDown already handled, avoid duplication)
        if (fileCompletion.isOpen || commandCompletion.isOpen || agentCompletion.isOpen) {
          return;
        }

        // Check if composition input just ended
        const isRecentlyComposing = Date.now() - lastCompositionEndTimeRef.current < 100;

        // Determine send behavior based on sendShortcut setting
        const shift = (ev as KeyboardEvent).shiftKey === true;
        const metaOrCtrl = ev.metaKey || ev.ctrlKey;
        const isSendKey =
          sendShortcut === 'cmdEnter'
            ? isEnterKey && metaOrCtrl && !isComposingRef.current && !isComposing
            : isEnterKey &&
              !shift &&
              !isComposingRef.current &&
              !isComposing &&
              !isRecentlyComposing;

        // Use ref instead of state to check composing state, because ref is sync
        if (isSendKey) {
          ev.preventDefault();
          submittedOnEnterRef.current = true;
          handleSubmit();
        }
      };

      const nativeKeyUp = (ev: KeyboardEvent) => {
        const isEnterKey =
          ev.key === 'Enter' ||
          (ev as unknown as { keyCode?: number }).keyCode === 13 ||
          (ev as unknown as { which?: number }).which === 13;
        const shift = (ev as KeyboardEvent).shiftKey === true;
        const metaOrCtrl = ev.metaKey || ev.ctrlKey;

        // Determine if send key based on sendShortcut setting
        const isSendKey =
          sendShortcut === 'cmdEnter' ? isEnterKey && metaOrCtrl : isEnterKey && !shift;

        if (isSendKey) {
          ev.preventDefault();
          // If item was just selected in completion menu, don't send message
          if (completionSelectedRef.current) {
            completionSelectedRef.current = false;
            return;
          }
          if (submittedOnEnterRef.current) {
            submittedOnEnterRef.current = false;
            return;
          }
        }
      };

      const nativeBeforeInput = (ev: InputEvent) => {
        const type = (ev as InputEvent).inputType;
        if (type === 'insertParagraph') {
          // For cmdEnter mode, normal Enter should allow newline
          if (sendShortcut === 'cmdEnter') {
            // Allow default newline behavior
            return;
          }

          ev.preventDefault();
          // If item was just selected in completion menu with enter, don't send message
          if (completionSelectedRef.current) {
            completionSelectedRef.current = false;
            return;
          }
          // Don't send message when completion menu is open
          if (fileCompletion.isOpen || commandCompletion.isOpen || agentCompletion.isOpen) {
            return;
          }
          handleSubmit();
        }
      };

      el.addEventListener('keydown', nativeKeyDown, { capture: true });
      el.addEventListener('keyup', nativeKeyUp, { capture: true });
      el.addEventListener('beforeinput', nativeBeforeInput as EventListener, {
        capture: true,
      });

      return () => {
        el.removeEventListener('keydown', nativeKeyDown, { capture: true });
        el.removeEventListener('keyup', nativeKeyUp, { capture: true });
        el.removeEventListener('beforeinput', nativeBeforeInput as EventListener, {
          capture: true,
        });
      };
    }, [
      isComposing,
      isComposingRef,
      handleSubmit,
      handleEnhancePrompt,
      fileCompletion,
      commandCompletion,
      agentCompletion,
      sendShortcut,
      lastCompositionEndTimeRef,
    ]);

    // Paste and drop hook
    const { handlePaste, handleDragOver, handleDrop } = usePasteAndDrop({
      editableRef,
      pathMappingRef,
      getTextContent,
      adjustHeight,
      renderFileTags,
      setHasContent,
      setInternalAttachments,
      onInput,
      fileCompletion,
      commandCompletion,
      handleInput,
    });

    /**
     * Handle add attachment
     */
    const handleAddAttachment = useCallback(
      (files: FileList) => {
        if (externalAttachments !== undefined) {
          onAddAttachment?.(files);
        } else {
          // Use internal state
          Array.from(files).forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = (reader.result as string).split(',')[1];
              const attachment: Attachment = {
                id: generateId(),
                fileName: file.name,
                mediaType: file.type || 'application/octet-stream',
                data: base64,
              };
              setInternalAttachments((prev) => [...prev, attachment]);
            };
            reader.readAsDataURL(file);
          });
        }
      },
      [externalAttachments, onAddAttachment]
    );

    /**
     * Handle remove attachment
     */
    const handleRemoveAttachment = useCallback(
      (id: string) => {
        if (externalAttachments !== undefined) {
          onRemoveAttachment?.(id);
        } else {
          setInternalAttachments((prev) => prev.filter((a) => a.id !== id));
        }
      },
      [externalAttachments, onRemoveAttachment]
    );

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

    /**
     * Focus input box
     */
    const focusInput = useCallback(() => {
      editableRef.current?.focus();
    }, []);

    // Performance optimization: Imperative handle for uncontrolled mode
    // Exposes methods for parent to interact without causing re-renders
    useImperativeHandle(
      ref,
      () => ({
        getValue: () => {
          invalidateCache(); // Ensure fresh content
          return getTextContent();
        },
        setValue: (newValue: string) => {
          if (!editableRef.current) return;
          isExternalUpdateRef.current = true;
          editableRef.current.innerText = newValue;
          setHasContent(!!newValue.trim());
          adjustHeight();
          invalidateCache();

          // Move cursor to end
          if (newValue) {
            const range = document.createRange();
            const selection = window.getSelection();
            range.selectNodeContents(editableRef.current);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        },
        focus: focusInput,
        clear: clearInput,
        hasContent: () => hasContent,
        getFileTags: extractFileTags,
      }),
      [getTextContent, focusInput, clearInput, adjustHeight, invalidateCache, hasContent, extractFileTags]
    );

    // Global callbacks hook
    useGlobalCallbacks({
      editableRef,
      pathMappingRef,
      getTextContent,
      adjustHeight,
      renderFileTags,
      setHasContent,
      onInput,
      fileCompletion,
      commandCompletion,
      focusInput,
    });

    // Add space key listener to trigger file tag rendering
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        handleKeyDownForTagRendering(e);
      };

      if (editableRef.current) {
        editableRef.current.addEventListener('keydown', handleKeyDown);
      }

      return () => {
        if (editableRef.current) {
          editableRef.current.removeEventListener('keydown', handleKeyDown);
        }
      };
    }, [handleKeyDownForTagRendering]);

    return (
      <div className="chat-input-box" onClick={focusInput} ref={containerRef}>
        {/* SDK status loading or not installed warning bar */}
        {(sdkStatusLoading || !sdkInstalled) && (
          <div className={`sdk-warning-bar ${sdkStatusLoading ? 'sdk-loading' : ''}`}>
            <span
              className={`codicon ${sdkStatusLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-warning'}`}
            />
            <span className="sdk-warning-text">
              {sdkStatusLoading
                ? t('chat.sdkStatusLoading')
                : t('chat.sdkNotInstalled', {
                    provider: currentProvider === 'codex' ? 'Codex' : 'Claude Code',
                  })}
            </span>
            {!sdkStatusLoading && (
              <button
                className="sdk-install-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onInstallSdk?.();
                }}
              >
                {t('chat.goInstallSdk')}
              </button>
            )}
          </div>
        )}

        {/* Attachment list */}
        {attachments.length > 0 && (
          <AttachmentList attachments={attachments} onRemove={handleRemoveAttachment} />
        )}

        {/* Context bar (Top Control Bar) */}
        <ContextBar
          activeFile={activeFile}
          selectedLines={selectedLines}
          percentage={usagePercentage}
          usedTokens={usageUsedTokens}
          maxTokens={usageMaxTokens}
          showUsage={showUsage}
          onClearFile={onClearContext}
          onAddAttachment={handleAddAttachment}
          selectedAgent={selectedAgent}
          onClearAgent={() => onAgentSelect?.(null)}
          currentProvider={currentProvider}
          hasMessages={hasMessages}
          onRewind={onRewind}
        />

        {/* Input area */}
        <div
          className="input-editable-wrapper"
          onMouseOver={handleMouseOver}
          onMouseLeave={handleMouseLeave}
        >
          <div
            ref={editableRef}
            className="input-editable"
            contentEditable={!disabled}
            data-placeholder={placeholder}
            onInput={(e) => {
              // Pass native event isComposing state, more accurate than React state
              // Can correctly capture input before compositionStart
              handleInput((e.nativeEvent as InputEvent).isComposing);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onBeforeInput={(e) => {
              const inputType = (e.nativeEvent as unknown as { inputType?: string }).inputType;
              if (inputType === 'insertParagraph') {
                e.preventDefault();
                // If item was just selected in completion menu with enter, don't send message
                if (completionSelectedRef.current) {
                  completionSelectedRef.current = false;
                  return;
                }
                // Don't send message when completion menu is open
                if (
                  fileCompletion.isOpen ||
                  commandCompletion.isOpen ||
                  agentCompletion.isOpen
                ) {
                  return;
                }
                // Only allow submit when not loading and not in IME composition
                if (!isLoading && !isComposing) {
                  handleSubmit();
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
            suppressContentEditableWarning
          />
        </div>

        {/* Bottom button area */}
        <ButtonArea
          disabled={disabled || isLoading}
          hasInputContent={hasContent || attachments.length > 0}
          isLoading={isLoading}
          isEnhancing={isEnhancing}
          selectedModel={selectedModel}
          permissionMode={permissionMode}
          currentProvider={currentProvider}
          reasoningEffort={reasoningEffort}
          onSubmit={handleSubmit}
          onStop={onStop}
          onModeSelect={handleModeSelect}
          onModelSelect={handleModelSelect}
          onProviderSelect={onProviderSelect}
          onReasoningChange={onReasoningChange}
          onEnhancePrompt={handleEnhancePrompt}
          alwaysThinkingEnabled={alwaysThinkingEnabled}
          onToggleThinking={onToggleThinking}
          streamingEnabled={streamingEnabled}
          onStreamingEnabledChange={onStreamingEnabledChange}
          selectedAgent={selectedAgent}
          onAgentSelect={(agent) => onAgentSelect?.(agent)}
          onOpenAgentSettings={onOpenAgentSettings}
          onClearAgent={() => onAgentSelect?.(null)}
        />

        {/* @ file reference dropdown menu */}
        <CompletionDropdown
          isVisible={fileCompletion.isOpen}
          position={fileCompletion.position}
          items={fileCompletion.items}
          selectedIndex={fileCompletion.activeIndex}
          loading={fileCompletion.loading}
          emptyText={t('chat.noMatchingFiles')}
          onClose={fileCompletion.close}
          onSelect={(_, index) => fileCompletion.selectIndex(index)}
          onMouseEnter={fileCompletion.handleMouseEnter}
        />

        {/* / slash command dropdown menu */}
        <CompletionDropdown
          isVisible={commandCompletion.isOpen}
          position={commandCompletion.position}
          width={450}
          items={commandCompletion.items}
          selectedIndex={commandCompletion.activeIndex}
          loading={commandCompletion.loading}
          emptyText={t('chat.noMatchingCommands')}
          onClose={commandCompletion.close}
          onSelect={(_, index) => commandCompletion.selectIndex(index)}
          onMouseEnter={commandCompletion.handleMouseEnter}
        />

        {/* # agent selection dropdown menu */}
        <CompletionDropdown
          isVisible={agentCompletion.isOpen}
          position={agentCompletion.position}
          width={350}
          items={agentCompletion.items}
          selectedIndex={agentCompletion.activeIndex}
          loading={agentCompletion.loading}
          emptyText={t('chat.noAvailableAgents')}
          onClose={agentCompletion.close}
          onSelect={(_, index) => agentCompletion.selectIndex(index)}
          onMouseEnter={agentCompletion.handleMouseEnter}
        />

        {/* Floating Tooltip (uses Portal or Fixed positioning to break overflow limit) */}
        {tooltip && tooltip.visible && (
          <div
            className={`tooltip-popup ${tooltip.isBar ? 'tooltip-bar' : ''}`}
            style={{
              top: `${tooltip.top}px`, // Use calculated top directly, no subtraction here
              left: `${tooltip.left}px`,
              width: tooltip.width ? `${tooltip.width}px` : undefined,
              // @ts-expect-error CSS custom properties
              '--tooltip-tx': tooltip.tx || '-50%',
              '--arrow-left': tooltip.arrowLeft || '50%',
            }}
          >
            {tooltip.text}
          </div>
        )}

        {/* Prompt enhancer dialog */}
        <PromptEnhancerDialog
          isOpen={showEnhancerDialog}
          isLoading={isEnhancing}
          originalPrompt={originalPrompt}
          enhancedPrompt={enhancedPrompt}
          onUseEnhanced={handleUseEnhancedPrompt}
          onKeepOriginal={handleKeepOriginalPrompt}
          onClose={handleCloseEnhancerDialog}
        />
      </div>
    );
  }
);

// Display name for React DevTools
ChatInputBox.displayName = 'ChatInputBox';

export default ChatInputBox;
