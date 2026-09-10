import { forwardRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ChatInputBoxHandle,
  ChatInputBoxProps,
} from './types.js';
import { DEFAULT_CLAUDE_MODEL_ID } from './types.js';
import { ChatInputBoxHeader } from './ChatInputBoxHeader.js';
import { ChatInputBoxFooter } from './ChatInputBoxFooter.js';
import { ResizeHandles } from './ResizeHandles.js';
import { InputEditableArea } from './InputEditableArea.js';
import { useChatInputController } from './hooks/useChatInputController.js';
import './styles.css';

/**
 * ChatInputBox - Chat input component
 * Uses contenteditable div with auto height adjustment, IME handling, @ file references, / slash commands
 *
 * Performance optimizations:
 * - Uses uncontrolled mode with useImperativeHandle for minimal re-renders
 * - Debounced onInput callback to reduce parent component updates
 * - Cached getTextContent to avoid repeated DOM traversal
 *
 * State and event wiring live in useChatInputController (and its
 * useChatInputTextPipeline); the editable region renders via InputEditableArea.
 */
export const ChatInputBox = memo(forwardRef<ChatInputBoxHandle, ChatInputBoxProps>(
  (
    {
      isLoading = false,
      selectedModel = DEFAULT_CLAUDE_MODEL_ID,
      permissionMode = 'default',
      currentProvider = 'claude',
      codexNativeAutoReviewAvailable = true,
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
      reasoningEffort = 'high',
      onReasoningChange,
      codexFastMode = 'normal',
      onCodexFastModeChange,
      dshPreset,
      onDshPresetChange,
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
      onOpenPromptSettings,
      onOpenModelSettings,
      onOpenCliSettings,
      hasMessages = false,
      onRewind,
      statusPanelExpanded = true,
      onToggleStatusPanel,
      sdkInstalled = true, // Default to true to avoid disabling input box on initial state
      sdkStatusLoading = false, // SDK status loading state
      sdkStatusError = false,
      onRetrySdkStatus,
      onInstallSdk,
      addToast,
      messageQueue,
      onRemoveFromQueue,
      autoOpenFileEnabled,
      onAutoOpenFileEnabledChange,
      longContextEnabled = true,
      onLongContextChange,
    }: ChatInputBoxProps,
    ref: React.ForwardedRef<ChatInputBoxHandle>
  ) => {
    const { t } = useTranslation();

    const {
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
    } = useChatInputController({
      isLoading,
      selectedModel,
      currentProvider,
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
      sendShortcut,
      sdkInstalled,
      sdkStatusLoading,
      onInstallSdk,
      addToast,
      onAgentSelect,
      onOpenAgentSettings,
      onOpenPromptSettings,
      t,
      ref,
    });

    return (
      <div
        className={`chat-input-box ${isResizingInputBox ? 'is-resizing' : ''}`}
        onClick={focusInput}
        ref={containerRef}
        style={containerStyle}
        onMouseOver={handleMouseOver}
        onMouseLeave={handleMouseLeave}
      >
        <ResizeHandles getHandleProps={getHandleProps} nudge={nudge} />

        <ChatInputBoxHeader
          sdkStatusLoading={sdkStatusLoading}
          sdkStatusError={sdkStatusError}
          sdkInstalled={sdkInstalled}
          currentProvider={currentProvider}
          onRetrySdkStatus={onRetrySdkStatus}
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
          onClearContext={handleClearFileContext}
          onAddAttachment={handleAddAttachment}
          selectedAgent={selectedAgent}
          onClearAgent={() => onAgentSelect?.(null)}
          hasMessages={hasMessages}
          onRewind={onRewind}
          statusPanelExpanded={statusPanelExpanded}
          onToggleStatusPanel={onToggleStatusPanel}
          messageQueue={messageQueue}
          onRemoveFromQueue={onRemoveFromQueue}
          showOpenSourceBanner={showOpenSourceBanner}
          onDismissOpenSourceBanner={handleDismissOpenSourceBanner}
          autoOpenFileEnabled={autoOpenFileEnabled}
          onRequestEnableFileContext={handleRequestEnableFileContext}
        />

        {/* Input area */}
        <InputEditableArea
          editableWrapperRef={editableWrapperRef}
          editableWrapperStyle={editableWrapperStyle}
          editableRef={editableRef}
          disabled={disabled}
          placeholder={placeholder}
          completionSuffix={inlineCompletion.suffix || ''}
          handleInput={handleInput}
          handleKeyDown={handleKeyDown}
          handleKeyUp={handleKeyUp}
          completionSelectedRef={completionSelectedRef}
          anyCompletionOpen={anyCompletionOpen}
          isLoading={isLoading}
          isComposingRef={isComposingRef}
          onSubmit={handleSubmit}
          handleCompositionStart={handleCompositionStart}
          handleCompositionEnd={handleCompositionEnd}
          handlePaste={handlePaste}
          handleDragOver={handleDragOver}
          handleDrop={handleDrop}
          ctxMenu={ctxMenu}
          onCut={handleCtxMenuCut}
          t={t}
        />

        <ChatInputBoxFooter
          disabled={disabled}
          hasInputContent={hasContent || attachments.length > 0}
          isLoading={isLoading}
          isEnhancing={isEnhancing}
          selectedModel={selectedModel}
          permissionMode={permissionMode}
          currentProvider={currentProvider}
          codexNativeAutoReviewAvailable={codexNativeAutoReviewAvailable}
          reasoningEffort={reasoningEffort}
          codexFastMode={codexFastMode}
          dshPreset={dshPreset}
          onSubmit={handleSubmit}
          onStop={onStop}
          onModeSelect={handleModeSelect}
          onModelSelect={handleModelSelect}
          onProviderSelect={onProviderSelect}
          onReasoningChange={onReasoningChange}
          onCodexFastModeChange={onCodexFastModeChange}
          onDshPresetChange={onDshPresetChange}
          onEnhancePrompt={handleEnhancePrompt}
          alwaysThinkingEnabled={alwaysThinkingEnabled}
          onToggleThinking={onToggleThinking}
          streamingEnabled={streamingEnabled}
          onStreamingEnabledChange={onStreamingEnabledChange}
          selectedAgent={selectedAgent}
          onAgentSelect={(agent) => onAgentSelect?.(agent)}
          onOpenAgentSettings={onOpenAgentSettings}
          onAddModel={onOpenModelSettings}
          onClearAgent={() => onAgentSelect?.(null)}
          onOpenCliSettings={onOpenCliSettings}
          longContextEnabled={longContextEnabled}
          onLongContextChange={onLongContextChange}
          fileCompletion={fileCompletion}
          commandCompletion={commandCompletion}
          agentCompletion={agentCompletion}
          promptCompletion={promptCompletion}
          dollarCommandCompletion={dollarCommandCompletion}
          tooltip={tooltip}
          promptEnhancer={promptEnhancer}
          t={t}
        />
      </div>
    );
  }
));

// Display name for React DevTools
ChatInputBox.displayName = 'ChatInputBox';

export default ChatInputBox;
