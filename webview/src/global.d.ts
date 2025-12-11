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
   * Handle file path dropped from Java
   */
  handleFilePathFromJava?: (filePath: string) => void;

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
   * Clear all messages
   */
  clearMessages?: () => void;

  /**
   * Add error message
   */
  addErrorMessage?: (message: string) => void;

  /**
   * Usage statistics update callback
   */
  onUsageUpdate?: (json: string) => void;

  /**
   * Mode changed callback
   */
  onModeChanged?: (mode: string) => void;

  /**
   * Model changed callback
   */
  onModelChanged?: (modelId: string) => void;

  /**
   * Show permission dialog
   */
  showPermissionDialog?: (json: string) => void;

  /**
   * Add selection info (file and line numbers)
   */
  addSelectionInfo?: (selectionInfo: string) => void;

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
   * Update providers list
   */
  updateProviders?: (json: string) => void;

  /**
   * Update active provider
   */
  updateActiveProvider?: (providerId: string) => void;

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
}
