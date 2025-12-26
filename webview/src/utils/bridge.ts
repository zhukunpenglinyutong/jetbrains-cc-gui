const BRIDGE_UNAVAILABLE_WARNED = new Set<string>();

const callBridge = (payload: string) => {
  if (window.sendToJava) {
    // const timestamp = Date.now();
    // console.log(`[Bridge][${timestamp}][PERF] Sending to Java:`, payload.substring(0, 100));
    // // 记录消息发送时间，用于计算端到端延迟
    // if (payload.startsWith('send_message')) {
    //   console.log(`[Bridge][${timestamp}][PERF] >>> 用户消息发送开始 <<<`);
    //   (window as any).__lastMessageSendTime = timestamp;
    // }
    window.sendToJava(payload);
    return true;
  }
  if (!BRIDGE_UNAVAILABLE_WARNED.has(payload)) {
    console.warn('[Bridge] sendToJava not available yet. payload=', payload.substring(0, 50));
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
