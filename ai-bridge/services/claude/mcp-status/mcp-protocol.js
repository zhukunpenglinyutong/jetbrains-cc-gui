/**
 * MCP 协议工具模块
 * 提供 MCP 协议相关的工具函数
 */

/**
 * 创建 MCP initialize 请求
 * @returns {string} JSON-RPC 格式的初始化请求
 */
export function createInitializeRequest() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codemoss-ide', version: '1.0.0' }
    }
  }) + '\n';
}

/**
 * 检查输出是否包含有效的 MCP 协议响应
 * @param {string} stdout - 标准输出
 * @returns {boolean}
 */
export function hasValidMcpResponse(stdout) {
  return stdout.includes('"jsonrpc"') || stdout.includes('"result"');
}

/**
 * 解析 SSE (Server-Sent Events) 响应
 * @param {string} text - SSE 响应文本
 * @returns {Array<Object>} 解析后的事件数组
 */
export function parseSSE(text) {
  const events = [];
  const lines = text.split('\n');
  let currentEvent = {};

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('data:')) {
      // Handle both "data: " and "data:" formats
      const data = trimmedLine.startsWith('data: ') ? trimmedLine.substring(6) : trimmedLine.substring(5);
      try {
        currentEvent.data = JSON.parse(data);
      } catch (e) {
        currentEvent.data = data;
      }
    } else if (trimmedLine.startsWith('event:')) {
      // Handle both "event: " and "event:" formats
      currentEvent.event = trimmedLine.startsWith('event: ') ? trimmedLine.substring(7) : trimmedLine.substring(6);
    } else if (trimmedLine.startsWith('id:')) {
      // Handle both "id: " and "id:" formats
      currentEvent.id = trimmedLine.startsWith('id: ') ? trimmedLine.substring(4) : trimmedLine.substring(3);
    } else if (trimmedLine === '') {
      // Empty line means end of event
      if (Object.keys(currentEvent).length > 0) {
        events.push(currentEvent);
        currentEvent = {};
      }
    }
  }

  // Don't forget the last event if there's no trailing newline
  if (Object.keys(currentEvent).length > 0) {
    events.push(currentEvent);
  }

  return events;
}
