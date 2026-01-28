/**
 * HTTP/SSE 工具获取模块
 * 提供从 HTTP/SSE 类型 MCP 服务器获取工具列表的功能
 */

import { log } from './logger.js';
import { parseSSE } from './mcp-protocol.js';

/**
 * 获取 HTTP/SSE 类型服务器的工具列表
 * 支持 MCP Streamable HTTP 的会话管理（Mcp-Session-Id）
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 工具列表响应
 */
export async function getHttpServerTools(serverName, serverConfig) {
  const result = {
    name: serverName,
    tools: [],
    error: null,
    serverType: serverConfig.type || 'sse'
  };

  const url = serverConfig.url;
  if (!url) {
    result.error = 'No URL specified for HTTP/SSE server';
    return result;
  }

  log('info', '[MCP Tools] Starting tools fetch for HTTP/SSE server:', serverName);

  // Build headers with authorization if provided
  const baseHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(serverConfig.headers || {})
  };

  // If URL has Authorization in query string, extract it and add to headers
  let fetchUrl = url;
  try {
    const urlObj = new URL(url);
    const authParam = urlObj.searchParams.get('Authorization');
    if (authParam) {
      baseHeaders['Authorization'] = authParam;
      // Remove from URL to avoid duplicate
      urlObj.searchParams.delete('Authorization');
      fetchUrl = urlObj.toString();
    }
  } catch (e) {
    // Invalid URL, continue with original
  }

  let requestId = 0;
  let sessionId = null;

  /**
   * 发送 MCP 请求，支持会话管理和重试
   * @param {string} method - MCP 方法名
   * @param {Object} params - 请求参数
   * @param {number} retryCount - 当前重试次数
   * @returns {Promise<Object>} 响应数据
   */
  const sendRequest = async (method, params = {}, retryCount = 0) => {
    const id = ++requestId;
    const request = {
      jsonrpc: '2.0',
      id: id,
      method: method,
      params: params
    };

    // 构建请求头，包含会话 ID（如果存在）
    const headers = { ...baseHeaders };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
      log('debug', '[MCP Tools] Including session ID:', sessionId);
    }

    log('info', '[MCP Tools] ' + serverName + ' sending ' + method + ' request (id: ' + id + ')');

    // 指数退避超时：第一次 10s，第二次 15s，第三次 20s
    const timeoutMs = 10000 + (retryCount * 5000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(request),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // 如果是 404 或 405，可能是旧版 SSE 传输，需要特殊处理
        if (response.status === 404 || response.status === 405) {
          log('warn', '[MCP Tools] Server returned ' + response.status + ', may be using legacy SSE transport');
        }
        throw new Error('HTTP ' + response.status + ': ' + response.statusText);
      }

      // 提取会话 ID（从响应头）
      const responseSessionId = response.headers.get('Mcp-Session-Id');
      if (responseSessionId && !sessionId) {
        sessionId = responseSessionId;
        log('info', '[MCP Tools] Received session ID:', sessionId);
      }

      const responseText = await response.text();

      // Try to parse as SSE first
      const events = parseSSE(responseText);
      if (events.length > 0 && events[0].data) {
        const data = events[0].data;

        if (data.error) {
          // 如果是会话相关的错误，尝试重试
          if (data.error.code === -32600 || data.error.message?.includes('session')) {
            if (retryCount < 2) {
              log('warn', '[MCP Tools] Session error, retrying...');
              await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
              return sendRequest(method, params, retryCount + 1);
            }
          }
          throw new Error('Server error: ' + (data.error.message || JSON.stringify(data.error)));
        }

        return data;
      }

      // Fall back to JSON parsing
      try {
        const data = JSON.parse(responseText);

        if (data.error) {
          // 如果是会话相关的错误，尝试重试
          if (data.error.code === -32600 || data.error.message?.includes('session')) {
            if (retryCount < 2) {
              log('warn', '[MCP Tools] Session error, retrying...');
              await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
              return sendRequest(method, params, retryCount + 1);
            }
          }
          throw new Error('Server error: ' + (data.error.message || JSON.stringify(data.error)));
        }

        return data;
      } catch (parseError) {
        throw new Error('Failed to parse response: ' + parseError.message);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout after ' + timeoutMs + 'ms');
      }
      // 网络错误重试
      if ((error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) && retryCount < 2) {
        log('warn', '[MCP Tools] Network error, retrying...', error.message);
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return sendRequest(method, params, retryCount + 1);
      }
      log('error', '[MCP Tools] ' + serverName + ' request failed:', error.message);
      throw error;
    }
  };

  try {
    // 发送初始化请求
    const initResponse = await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codemoss-ide', version: '1.0.0' }
    });

    if (!initResponse.result) {
      throw new Error('Invalid initialize response: missing result');
    }

    log('info', '[MCP Tools] ' + serverName + ' initialized successfully');

    // 如果有会话 ID，现在已建立会话，后续请求将使用相同的会话
    if (sessionId) {
      log('info', '[MCP Tools] Using session:', sessionId);
    }

    // 发送 tools/list 请求（现在会包含会话 ID）
    const toolsResponse = await sendRequest('tools/list', {});

    if (toolsResponse.result && toolsResponse.result.tools) {
      const tools = toolsResponse.result.tools;
      log('info', '[MCP Tools] ' + serverName + ' received tools/list response: ' + tools.length + ' tools');
      result.tools = tools;
    } else {
      result.tools = [];
    }

  } catch (error) {
    log('error', '[MCP Tools] ' + serverName + ' failed:', error.message);
    result.error = error.message;
  }

  return result;
}
