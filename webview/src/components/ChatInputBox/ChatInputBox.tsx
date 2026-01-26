import {
  forwardRef,
  useCallback,
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
  useInputHistory,
  useSubmitHandler,
  useKeyboardHandler,
  useNativeEventCapture,
  useControlledValueSync,
  useAttachmentHandlers,
  useChatInputImperativeHandle,
  useSpaceKeyListener,
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

    useSpaceKeyListener({ editableRef, onKeyDown: handleKeyDownForTagRendering });

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
          statusPanelExpanded={statusPanelExpanded}
          onToggleStatusPanel={onToggleStatusPanel}
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
