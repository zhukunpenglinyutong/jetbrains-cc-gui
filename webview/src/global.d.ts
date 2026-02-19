/**
 * Global window interface extensions for IDEA plugin communication
 */
interface Window {
  /**
   * Send message to Java backend
   */
  sendToJava?: (message: string) => void;

  /**
   * Get clipboard file path from Java
   */
  getClipboardFilePath?: () => Promise<string>;

  /**
   * Handle file path(s) dropped from Java (supports batch files)
   */
  handleFilePathFromJava?: (filePathInput: string | string[]) => void;

  /**
   * Update messages from backend
   */
  updateMessages?: (json: string) => void;

  /**
   * Update status message
   */
  updateStatus?: (text: string) => void;

  /**
   * Show loading indicator
   */
  showLoading?: (value: string | boolean) => void;

  /**
   * Show thinking status
   */
  showThinkingStatus?: (value: string | boolean) => void;

  /**
   * Set history data
   */
  setHistoryData?: (data: any) => void;

  /**
   * Export session data callback
   */
  onExportSessionData?: (json: string) => void;

  /**
   * Clear all messages
   */
  clearMessages?: () => void;

  /**
   * Add error message
   */
  addErrorMessage?: (message: string) => void;

  /**
   * Add single history message (used for Codex session loading)
   */
  addHistoryMessage?: (message: any) => void;

  /**
   * History load complete callback - invoked when history messages finish loading.
   * Triggers Markdown re-rendering to fix incorrect rendering on first history load.
   */
  historyLoadComplete?: () => void;

  /**
   * Add user message to chat (used for external Quick Fix feature)
   * Immediately shows the user's message in the chat UI before AI response
   */
  addUserMessage?: (content: string) => void;

  /**
   * Set current session ID (for rewind feature)
   */
  setSessionId?: (sessionId: string) => void;

  /**
   * Add toast notification (called from backend)
   */
  addToast?: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;

  /**
   * Usage statistics update callback
   */
  onUsageUpdate?: (json: string) => void;

  /**
   * Mode changed callback
   */
  onModeChanged?: (mode: string) => void;

  /**
   * Mode received callback - backend pushes the permission mode (called during window initialization)
   */
  onModeReceived?: (mode: string) => void;

  /**
   * Model changed callback
   */
  onModelChanged?: (modelId: string) => void;

  /**
   * Model confirmed callback - called after the backend confirms the model was set successfully
   * @param modelId The confirmed model ID
   * @param provider The current provider
   */
  onModelConfirmed?: (modelId: string, provider: string) => void;

  /**
   * Show permission dialog
   */
  showPermissionDialog?: (json: string) => void;

  /**
   * Show AskUserQuestion dialog
   */
  showAskUserQuestionDialog?: (json: string) => void;

  /**
   * Show PlanApproval dialog
   */
  showPlanApprovalDialog?: (json: string) => void;

  /**
   * Add selection info (file and line numbers) - auto-tracked, only updates ContextBar
   */
  addSelectionInfo?: (selectionInfo: string) => void;

  /**
   * Add code snippet to input box - manually triggered, inserts a code snippet tag into the input box
   */
  addCodeSnippet?: (selectionInfo: string) => void;

  /**
   * Insert code snippet at cursor position - registered by ChatInputBox
   */
  insertCodeSnippetAtCursor?: (selectionInfo: string) => void;

  /**
   * Clear selection info
   */
  clearSelectionInfo?: () => void;

  /**
   * File list result callback (for file reference provider)
   */
  onFileListResult?: (json: string) => void;

  /**
   * Command list result callback (for slash command provider)
   */
  onCommandListResult?: (json: string) => void;

  /**
   * Update MCP servers list
   */
  updateMcpServers?: (json: string) => void;

  /**
   * Update MCP server connection status
   */
  updateMcpServerStatus?: (json: string) => void;

  /**
   * Update MCP server tools list
   */
  updateMcpServerTools?: (json: string) => void;

  mcpServerToggled?: (json: string) => void;

  /**
   * Update Codex MCP servers list (from ~/.codex/config.toml)
   */
  updateCodexMcpServers?: (json: string) => void;

  /**
   * Update Codex MCP server connection status
   */
  updateCodexMcpServerStatus?: (json: string) => void;

  /**
   * Codex MCP server toggled callback
   */
  codexMcpServerToggled?: (json: string) => void;

  /**
   * Codex MCP server added callback
   */
  codexMcpServerAdded?: (json: string) => void;

  /**
   * Codex MCP server updated callback
   */
  codexMcpServerUpdated?: (json: string) => void;

  /**
   * Codex MCP server deleted callback
   */
  codexMcpServerDeleted?: (json: string) => void;

  /**
   * Update providers list
   */
  updateProviders?: (json: string) => void;

  /**
   * Update active provider
   */
  updateActiveProvider?: (providerId: string) => void;

  updateThinkingEnabled?: (json: string) => void;

  /**
   * Update streaming enabled setting
   */
  updateStreamingEnabled?: (json: string) => void;

  /**
   * Update send shortcut setting
   */
  updateSendShortcut?: (json: string) => void;

  /**
   * Update auto open file enabled setting
   */
  updateAutoOpenFileEnabled?: (json: string) => void;

  /**
   * Update commit AI prompt configuration
   */
  updateCommitPrompt?: (json: string) => void;

  /**
   * Update current Claude config
   */
  updateCurrentClaudeConfig?: (json: string) => void;

  /**
   * Show error message
   */
  showError?: (message: string) => void;

  /**
   * Show switch success message
   */
  showSwitchSuccess?: (message: string) => void;

  /**
   * Update Node.js path
   */
  updateNodePath?: (path: string) => void;

  /**
   * Update working directory configuration
   */
  updateWorkingDirectory?: (json: string) => void;

  /**
   * Show success message
   */
  showSuccess?: (message: string) => void;

  /**
   * Update skills list
   */
  updateSkills?: (json: string) => void;

  /**
   * Skill import result callback
   */
  skillImportResult?: (json: string) => void;

  /**
   * Skill delete result callback
   */
  skillDeleteResult?: (json: string) => void;

  /**
   * Skill toggle result callback
   */
  skillToggleResult?: (json: string) => void;

  /**
   * Update usage statistics
   */
  updateUsageStatistics?: (json: string) => void;

  /**
   * Pending usage statistics before component mounts
   */
  __pendingUsageStatistics?: string;

  /**
   * Update slash commands list (from SDK)
   */
  updateSlashCommands?: (json: string) => void;

  /**
   * Pending slash commands payload before provider initialization
   */
  __pendingSlashCommands?: string;

  /**
   * Pending session ID before App component mounts (for rewind feature)
   */
  __pendingSessionId?: string;

  /**
   * Apply IDEA editor font configuration (called from Java backend)
   * @param config Font configuration object containing fontFamily, fontSize, lineSpacing, fallbackFonts
   */
  applyIdeaFontConfig?: (config: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
    fallbackFonts?: string[];
  }) => void;

  /**
   * Pending font config before applyIdeaFontConfig is registered
   */
  __pendingFontConfig?: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
    fallbackFonts?: string[];
  };

  /**
   * Apply IDEA language configuration (called from Java backend)
   * @param config Language configuration object containing language code and IDEA locale
   */
  applyIdeaLanguageConfig?: (config: {
    language: string;
    ideaLocale?: string;
  }) => void;

  /**
   * Pending language config before applyIdeaLanguageConfig is registered
   */
  __pendingLanguageConfig?: {
    language: string;
    ideaLocale?: string;
  };

  /**
   * Update enhanced prompt result (for prompt enhancer feature)
   */
  updateEnhancedPrompt?: (result: string) => void;

  /**
   * Update session title (called when session title changes)
   */
  updateSessionTitle?: (title: string) => void;

  /**
   * Editor font config received callback - receives IDEA editor font configuration
   */
  onEditorFontConfigReceived?: (json: string) => void;

  /**
   * IDE theme received callback - receives IDE theme configuration
   */
  onIdeThemeReceived?: (json: string) => void;

  /**
   * IDE theme changed callback - invoked when the IDE theme changes
   */
  onIdeThemeChanged?: (json: string) => void;

  /**
   * Update agents list
   */
  updateAgents?: (json: string) => void;

  /**
   * Agent operation result callback
   */
  agentOperationResult?: (json: string) => void;

  /**
   * Update prompts list
   */
  updatePrompts?: (json: string) => void;

  /**
   * Prompt operation result callback
   */
  promptOperationResult?: (json: string) => void;

  /**
   * Selected agent received callback - receives the currently selected agent during initialization
   */
  onSelectedAgentReceived?: (json: string) => void;

  /**
   * Selected agent changed callback - invoked after an agent is selected
   */
  onSelectedAgentChanged?: (json: string) => void;

  /**
   * Update Codex providers list
   */
  updateCodexProviders?: (json: string) => void;

  /**
   * Update active Codex provider
   */
  updateActiveCodexProvider?: (json: string) => void;

  /**
   * Update current Codex config (from ~/.codex/)
   */
  updateCurrentCodexConfig?: (json: string) => void;

// ============================================================================
  // Streaming Callbacks
  // ============================================================================

  /**
   * Stream start callback - called when streaming begins
   */
  onStreamStart?: () => void;

  /**
   * Content delta callback - called when a content delta is received
   * @param delta The content delta string
   */
  onContentDelta?: (delta: string) => void;

  /**
   * Thinking delta callback - called when a thinking delta is received
   * @param delta The thinking delta string
   */
  onThinkingDelta?: (delta: string) => void;

  /**
   * Stream end callback - called when streaming ends
   */
  onStreamEnd?: () => void;

  /**
   * Permission denied callback - called when permission is denied.
   * Marks incomplete tool calls as "interrupted".
   */
  onPermissionDenied?: () => void;

  /**
   * Set of denied tool call IDs.
   * Used by tool blocks to determine which tool calls had their permission denied by the user.
   */
  __deniedToolIds?: Set<string>;

  /**
   * Session transition suppression flag.
   * Set to true during new session creation to prevent stale callbacks from writing old messages via updateMessages.
   */
  __sessionTransitioning?: boolean;

  /**
   * Update streaming enabled configuration - receives streaming config
   */
  updateStreamingEnabled?: (json: string) => void;

  /**
   * Rewind result callback - returns the result of a rewind operation
   */
  onRewindResult?: (json: string) => void;

  /**
   * Undo file result callback - returns the result of a single-file undo operation
   */
  onUndoFileResult?: (json: string) => void;

  /**
   * Undo all files result callback - returns the result of a batch undo operation
   */
  onUndoAllFileResult?: (json: string) => void;

  /**
   * Handle remove file from edits list - removes a file from the edits list (called when the user fully reverts changes in the diff view)
   */
  handleRemoveFileFromEdits?: (json: string) => void;

  /**
   * Handle interactive diff result - processes the result of an interactive diff action (Apply/Reject)
   * @param json JSON string containing { filePath, action, content?, error? }
   */
  handleDiffResult?: (json: string) => void;

  // ============================================================================
  // Dependency Management Callbacks
  // ============================================================================

  /**
   * Update dependency status callback
   */
  updateDependencyStatus?: (json: string) => void;

  /**
   * Dependency install progress callback
   */
  dependencyInstallProgress?: (json: string) => void;

  /**
   * Dependency install result callback
   */
  dependencyInstallResult?: (json: string) => void;

  /**
   * Dependency uninstall result callback
   */
  dependencyUninstallResult?: (json: string) => void;

  /**
   * Node environment status callback
   */
  nodeEnvironmentStatus?: (json: string) => void;

  /**
   * Dependency update available callback
   */
  dependencyUpdateAvailable?: (json: string) => void;

  /**
   * Pending dependency updates payload before settings initialization
   */
  __pendingDependencyUpdates?: string;

  /**
   * Pending dependency status payload before React initialization
   */
  __pendingDependencyStatus?: string;

  /**
   * Pending streaming enabled status before React initialization
   */
  __pendingStreamingEnabled?: string;

  /**
   * Pending send shortcut status before React initialization
   */
  __pendingSendShortcut?: string;

  /**
   * Pending auto open file enabled status before React initialization
   */
  __pendingAutoOpenFileEnabled?: string;

  __pendingPermissionDialogRequests?: string[];

  __pendingAskUserQuestionDialogRequests?: string[];

  __pendingPlanApprovalDialogRequests?: string[];

  /**
   * Pending user message before addUserMessage is registered (for Quick Fix feature)
   */
  __pendingUserMessage?: string;

  /**
   * Pending loading state before showLoading is registered (for Quick Fix feature)
   */
  __pendingLoadingState?: boolean;
}
