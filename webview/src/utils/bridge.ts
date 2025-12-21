const BRIDGE_UNAVAILABLE_WARNED = new Set<string>();

const callBridge = (payload: string) => {
  if (window.sendToJava) {
    window.sendToJava(payload);
    return true;
  }
  if (!BRIDGE_UNAVAILABLE_WARNED.has(payload)) {
    console.warn('[Claude Bridge] sendToJava not available. payload=', payload);
    BRIDGE_UNAVAILABLE_WARNED.add(payload);
  }
  return false;
};

export const sendBridgeEvent = (event: string, content = '') => {
  callBridge(`${event}:${content}`);
};

export const openFile = (filePath?: string) => {
  if (!filePath) {
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

/**
 * Send message to Java backend with object payload
 * @param message Message type
 * @param payload Payload object
 */
export const sendToJava = (message: string, payload: any = {}) => {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  sendBridgeEvent(message, payloadStr);
};

/**
 * Refresh a file in IDEA after it has been modified
 * @param filePath The path of the file to refresh
 */
export const refreshFile = (filePath: string) => {
  if (!filePath) return;
  sendToJava('refresh_file', { filePath });
};

/**
 * Show diff view in IDEA
 * @param filePath The path of the file
 * @param oldContent The content before the edit
 * @param newContent The content after the edit
 * @param title Optional title for the diff view
 */
export const showDiff = (filePath: string, oldContent: string, newContent: string, title?: string) => {
  sendToJava('show_diff', { filePath, oldContent, newContent, title });
};

/**
 * Show multi-edit diff view in IDEA
 * @param filePath The path of the file
 * @param edits Array of edit operations
 * @param currentContent Optional current content of the file
 */
export const showMultiEditDiff = (
  filePath: string,
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>,
  currentContent?: string
) => {
  sendToJava('show_multi_edit_diff', { filePath, edits, currentContent });
};

