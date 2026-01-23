const BRIDGE_UNAVAILABLE_WARNED = new Set<string>();

/** Path traversal patterns to detect (including URL-encoded variants) */
const PATH_TRAVERSAL_PATTERNS = [
  '..',           // Direct traversal
  '~',            // Home directory reference
  '%2e%2e',       // URL-encoded ..
  '%2E%2E',       // URL-encoded .. (uppercase)
  '%252e%252e',   // Double URL-encoded ..
];

/**
 * Validate file path doesn't contain path traversal patterns
 * Defense-in-depth: backend also validates using canonical paths
 */
const isValidPath = (filePath: string): boolean => {
  if (!filePath) return false;
  // Check both original and decoded path for traversal patterns
  const decodedPath = decodeURIComponent(filePath);
  return !PATH_TRAVERSAL_PATTERNS.some(pattern =>
    filePath.toLowerCase().includes(pattern.toLowerCase()) ||
    decodedPath.toLowerCase().includes(pattern.toLowerCase())
  );
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
