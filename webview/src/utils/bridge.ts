const BRIDGE_UNAVAILABLE_WARNED = new Set<string>();

/** Regex to detect path traversal: matches ".." as a path segment, not as part of filenames */
const PATH_TRAVERSAL_REGEX = /(^|[\\/])\.\.($|[\\/])/;

/**
 * Validate file path doesn't contain path traversal patterns
 * Defense-in-depth: backend also validates using canonical paths
 */
const isValidPath = (filePath: string): boolean => {
  if (!filePath) return false;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(filePath);
  } catch {
    return false;
  }
  return !PATH_TRAVERSAL_REGEX.test(filePath) && !PATH_TRAVERSAL_REGEX.test(decodedPath);
};

const callBridge = (payload: string) => {
  if (window.sendToJava) {
    window.sendToJava(payload);
    return true;
  }
  // Track warned payloads to avoid spam, but don't log to console
  BRIDGE_UNAVAILABLE_WARNED.add(payload);
  return false;
};

export const sendBridgeEvent = (event: string, content = '') => {
  return callBridge(`${event}:${content}`);
};

export const openFile = (filePath?: string) => {
  if (!filePath) {
    return;
  }
  // Security: Validate file path
  if (!isValidPath(filePath)) {
    return;
  }
  sendBridgeEvent('open_file', filePath);
};

export const openBrowser = (url?: string) => {
  if (!url) {
    return;
  }
  sendBridgeEvent('open_browser', url);
};

export const sendToJava = (message: string, payload: any = {}) => {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  sendBridgeEvent(message, payloadStr);
};

export const refreshFile = (filePath: string) => {
  if (!filePath) return;
  sendToJava('refresh_file', { filePath });
};

export const showDiff = (filePath: string, oldContent: string, newContent: string, title?: string) => {
  sendToJava('show_diff', { filePath, oldContent, newContent, title });
};

export const showMultiEditDiff = (
  filePath: string,
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>,
  currentContent?: string
) => {
  sendToJava('show_multi_edit_diff', { filePath, edits, currentContent });
};

/**
 * Show editable diff view for a file
 * Opens IDEA's native diff view where user can selectively accept/reject changes
 * @param filePath - Absolute path to the file
 * @param operations - Array of edit operations
 * @param status - File status: 'A' (added) or 'M' (modified)
 */
export const showEditableDiff = (
  filePath: string,
  operations: Array<{ oldString: string; newString: string; replaceAll?: boolean }>,
  status: 'A' | 'M'
) => {
  // Security: Validate file path (defense-in-depth, backend also validates)
  if (!isValidPath(filePath)) {
    return;
  }
  sendToJava('show_editable_diff', { filePath, operations, status });
};

/**
 * Show edit preview diff (current content → after edit)
 * Used to preview the effect before executing edits
 * @param filePath - Absolute path to the file
 * @param edits - Array of edit operations to preview
 * @param title - Optional title for the diff view
 */
export const showEditPreviewDiff = (
  filePath: string,
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>,
  title?: string
) => {
  if (!isValidPath(filePath)) {
    return;
  }
  sendToJava('show_edit_preview_diff', { filePath, edits, title });
};

/**
 * Show edit full diff (original content → modified content)
 * Used to show complete file comparison before and after modification
 * @param filePath - Absolute path to the file
 * @param oldString - The original string that was replaced
 * @param newString - The new string that replaced the original
 * @param originalContent - Optional cached original file content (for full file diff)
 * @param replaceAll - Whether to replace all occurrences
 * @param title - Optional title for the diff view
 */
export const showEditFullDiff = (
  filePath: string,
  oldString: string,
  newString: string,
  originalContent?: string,
  replaceAll?: boolean,
  title?: string
) => {
  if (!isValidPath(filePath)) {
    return;
  }
  sendToJava('show_edit_full_diff', { filePath, oldString, newString, originalContent, replaceAll, title });
};

/**
 * Show interactive diff view with Apply/Reject buttons
 * Based on the official Claude Code JetBrains plugin implementation
 * @param filePath - Absolute path to the file
 * @param newFileContents - The proposed new content for the file
 * @param tabName - Optional name for the diff tab
 * @param isNewFile - Whether this is a new file (no original content)
 */
export const showInteractiveDiff = (
  filePath: string,
  newFileContents: string,
  tabName?: string,
  isNewFile?: boolean
) => {
  if (!isValidPath(filePath)) {
    return;
  }
  sendToJava('show_interactive_diff', { filePath, newFileContents, tabName, isNewFile: isNewFile ?? false });
};

/**
 * Rewind files to a specific user message state
 * @param sessionId - Session ID
 * @param userMessageId - User message UUID to rewind to
 */
export const rewindFiles = (sessionId: string, userMessageId: string) => {
  sendToJava('rewind_files', { sessionId, userMessageId });
};

/**
 * Undo changes for a single file
 * @param filePath - Absolute path to the file
 * @param status - File status: 'A' (added) or 'M' (modified)
 * @param operations - Array of edit operations to reverse
 */
export const undoFileChanges = (
  filePath: string,
  status: 'A' | 'M',
  operations: Array<{ oldString: string; newString: string; replaceAll?: boolean }>
) => {
  // Security: Validate file path (defense-in-depth, backend also validates)
  if (!isValidPath(filePath)) {
    return;
  }
  sendToJava('undo_file_changes', { filePath, status, operations });
};
