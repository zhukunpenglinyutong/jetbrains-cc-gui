import {
  forwardRef,
  useCallback,
  useEffect,
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
import { ChatInputBoxHeader } from './ChatInputBoxHeader.js';
import { ChatInputBoxFooter } from './ChatInputBoxFooter.js';
import { ResizeHandles } from './ResizeHandles.js';
import {
  useCompletionDropdown,
  useCompletionTriggerDetection,
  useTextContent,
  useFileTags,
  useTooltip,
  useKeyboardNavigation,
  useIMEComposition,
  usePasteAndDrop,
  usePromptEnhancer,
  useGlobalCallbacks,
  useInputHistory,
  useSubmitHandler,
  useKeyboardHandler,
  useNativeEventCapture,
  useControlledValueSync,
  useAttachmentHandlers,
  useChatInputImperativeHandle,
  useSpaceKeyListener,
  useResizableChatInputBox,
  useInlineHistoryCompletion,
} from './hooks/index.js';
import {
  commandToDropdownItem,
  fileReferenceProvider,
  fileToDropdownItem,
  slashCommandProvider,
  agentProvider,
  agentToDropdownItem,
  preloadSlashCommands,
  type AgentItem,
} from './providers/index.js';
import { debounce } from './utils/debounce.js';
import { perfTimer } from '../../utils/debug.js';
import { DEBOUNCE_TIMING } from '../../constants/performance.js';
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
      hasMessages = false,
      onRewind,
      statusPanelExpanded = true,
      onToggleStatusPanel,
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
    const editableWrapperRef = useRef<HTMLDivElement>(null);
    const submittedOnEnterRef = useRef(false);
    const completionSelectedRef = useRef(false);
    const [hasContent, setHasContent] = useState(false);

    // Flag to track if we're updating from external value
    const isExternalUpdateRef = useRef(false);

    // Shared composing state ref - created early so it can be used by detectAndTriggerCompletion
    // This ref is synced with useIMEComposition's isComposingRef
    const sharedComposingRef = useRef(false);

    // Text content hook
    const { getTextContent, invalidateCache } = useTextContent({ editableRef });

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

    // Inline history completion hook (simple tab-complete style)
    const inlineCompletion = useInlineHistoryCompletion({
      debounceMs: 100,
      minQueryLength: 2,
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

    // Create debounced version of renderFileTags
    const debouncedRenderFileTags = useMemo(
      () => debounce(renderFileTags, DEBOUNCE_TIMING.FILE_TAG_RENDERING_MS),
      [renderFileTags]
    );

    // Completion trigger detection hook
    const { debouncedDetectCompletion } = useCompletionTriggerDetection({
      editableRef,
      sharedComposingRef,
      justRenderedTagRef,
      getTextContent,
      fileCompletion,
      commandCompletion,
      agentCompletion,
    });

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
        }, DEBOUNCE_TIMING.ON_INPUT_CALLBACK_MS),
      [onInput]
    );

    /**
     * Handle input event (optimized: use debounce to reduce performance overhead)
     * @param isComposingFromEvent - isComposing state from native event (higher priority)
     */
    const handleInput = useCallback(
      (isComposingFromEvent?: boolean) => {
        const timer = perfTimer('handleInput');

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
        timer.mark('invalidateCache');

        const text = getTextContent();
        timer.mark('getTextContent');

        // Remove zero-width and other invisible characters before checking if empty, ensure placeholder shows when only zero-width characters remain
        const cleanText = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
        const isEmpty = !cleanText.trim();

        // If content is empty, clear innerHTML to ensure :empty pseudo-class works (show placeholder)
        if (isEmpty && editableRef.current) {
          editableRef.current.innerHTML = '';
        }

        // Adjust height
        adjustHeight();
        timer.mark('adjustHeight');

        // Trigger completion detection and state update
        debouncedDetectCompletion();
        setHasContent(!isEmpty);

        // Update inline history completion
        // Only if no other completion menu is open
        // Note: Access isOpen directly from the completion objects at call time
        // to avoid unnecessary re-renders when isOpen changes
        const isOtherCompletionOpen = fileCompletion.isOpen || commandCompletion.isOpen || agentCompletion.isOpen;
        if (!isOtherCompletionOpen) {
          inlineCompletion.updateQuery(text);
        } else {
          inlineCompletion.clear();
        }

        // Notify parent component (use debounced version to reduce re-renders)
        // If determined empty (only zero-width characters), pass empty string to parent
        debouncedOnInput(isEmpty ? '' : text);

        timer.end();
      },
      // Note: fileCompletion/commandCompletion/agentCompletion objects are stable references
      // We access .isOpen at call time, so we don't need .isOpen in deps
      [
        getTextContent,
        adjustHeight,
        debouncedDetectCompletion,
        debouncedOnInput,
        invalidateCache,
        fileCompletion,
        commandCompletion,
        agentCompletion,
        inlineCompletion,
      ]
    );

    /**
     * Apply inline history completion (Tab key)
     */
    const applyInlineCompletion = useCallback(() => {
      const fullText = inlineCompletion.applySuggestion();
      if (!fullText || !editableRef.current) return false;

      // Fill the input with the complete text
      editableRef.current.innerText = fullText;

      // Set cursor to end
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(editableRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);

      // Update state
      handleInput();
      return true;
    }, [inlineCompletion, handleInput]);

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

    // Sync sharedComposingRef with isComposingRef for reliable composing state access
    // This ensures detectAndTriggerCompletion always has the latest composing state
    useEffect(() => {
      sharedComposingRef.current = isComposing;
    }, [isComposing]);

    const { record: recordInputHistory, handleKeyDown: handleHistoryKeyDown } = useInputHistory({
      editableRef,
      getTextContent,
      handleInput,
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

    const handleSubmit = useSubmitHandler({
      getTextContent,
      attachments,
      isLoading,
      sdkStatusLoading,
      sdkInstalled,
      currentProvider,
      clearInput,
      cancelPendingInput: debouncedOnInput.cancel,
      externalAttachments,
      setInternalAttachments,
      fileCompletion,
      commandCompletion,
      agentCompletion,
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

    const { onKeyDown: handleKeyDown, onKeyUp: handleKeyUp } = useKeyboardHandler({
      isComposing,
      lastCompositionEndTimeRef,
      sendShortcut,
      sdkStatusLoading,
      sdkInstalled,
      fileCompletion,
      commandCompletion,
      agentCompletion,
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
      isComposing,
      isComposingRef,
      lastCompositionEndTimeRef,
      sendShortcut,
      fileCompletion,
      commandCompletion,
      agentCompletion,
      completionSelectedRef,
      submittedOnEnterRef,
      handleSubmit,
      handleEnhancePrompt,
    });

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

    const { handleAddAttachment, handleRemoveAttachment } = useAttachmentHandlers({
      externalAttachments,
      onAddAttachment,
      onRemoveAttachment,
      setInternalAttachments,
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

    /**
     * Focus input box
     */
    const focusInput = useCallback(() => {
      editableRef.current?.focus();
    }, []);

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

    // 组件挂载时预加载斜杠命令，提升体感性能
    // 在用户输入 "/" 之前就加载命令数据，使其立即可用
    useEffect(() => {
      preloadSlashCommands();
    }, []);

    useSpaceKeyListener({ editableRef, onKeyDown: handleKeyDownForTagRendering });

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

    return (
      <div
        className={`chat-input-box ${isResizingInputBox ? 'is-resizing' : ''}`}
        onClick={focusInput}
        ref={containerRef}
        style={containerStyle}
      >
        <ResizeHandles getHandleProps={getHandleProps} nudge={nudge} />

        <ChatInputBoxHeader
          sdkStatusLoading={sdkStatusLoading}
          sdkInstalled={sdkInstalled}
          currentProvider={currentProvider}
          onInstallSdk={onInstallSdk}
          t={t}
          attachments={attachments}
          onRemoveAttachment={handleRemoveAttachment}
          activeFile={activeFile}
          selectedLines={selectedLines}
          usagePercentage={usagePercentage}
          usageUsedTokens={usageUsedTokens}
          usageMaxTokens={usageMaxTokens}
          showUsage={showUsage}
          onClearContext={onClearContext}
          onAddAttachment={handleAddAttachment}
          selectedAgent={selectedAgent}
          onClearAgent={() => onAgentSelect?.(null)}
          hasMessages={hasMessages}
          onRewind={onRewind}
          statusPanelExpanded={statusPanelExpanded}
          onToggleStatusPanel={onToggleStatusPanel}
        />

        {/* Input area */}
        <div
          ref={editableWrapperRef}
          className="input-editable-wrapper"
          onMouseOver={handleMouseOver}
          onMouseLeave={handleMouseLeave}
          style={editableWrapperStyle}
        >
          <div
            ref={editableRef}
            className="input-editable"
            contentEditable={!disabled}
            data-placeholder={placeholder}
            data-completion-suffix={inlineCompletion.suffix || ''}
            onInput={(e) => {
              // Pass native event isComposing state, more accurate than React state
              // Can correctly capture input before compositionStart
              handleInput((e.nativeEvent as InputEvent).isComposing);
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

        <ChatInputBoxFooter
          disabled={disabled}
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
          fileCompletion={fileCompletion}
          commandCompletion={commandCompletion}
          agentCompletion={agentCompletion}
          tooltip={tooltip}
          promptEnhancer={{
            isOpen: showEnhancerDialog,
            isLoading: isEnhancing,
            originalPrompt,
            enhancedPrompt,
            onUseEnhanced: handleUseEnhancedPrompt,
            onKeepOriginal: handleKeepOriginalPrompt,
            onClose: handleCloseEnhancerDialog,
          }}
          t={t}
        />
      </div>
    );
  }
);

// Display name for React DevTools
ChatInputBox.displayName = 'ChatInputBox';

export default ChatInputBox;
