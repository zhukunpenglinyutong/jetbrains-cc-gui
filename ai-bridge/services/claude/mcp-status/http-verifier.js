/**
 * HTTP/SSE 服务器验证模块
 * 提供 HTTP/SSE 类型 MCP 服务器的连接状态验证功能
 */

import { MCP_HTTP_VERIFY_TIMEOUT } from './config.js';
import { log } from './logger.js';
import { parseSSE, MCP_PROTOCOL_VERSION, MCP_CLIENT_INFO, buildSseRequestContext } from './mcp-protocol.js';

/**
 * 验证 HTTP/SSE 类型 MCP 服务器的连接状态
 * 实现基本的 MCP 初始化握手来验证服务器可用性
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 服务器状态信息
 */
export async function verifyHttpServerStatus(serverName, serverConfig) {
  const result = {
    name: serverName,
    status: 'pending',
    serverInfo: null
  };

  const url = serverConfig.url;
  if (!url) {
    result.status = 'failed';
    result.error = 'No URL specified for HTTP/SSE server';
    return result;
  }

  log('info', '[MCP Verify] Verifying HTTP/SSE server:', serverName, 'URL:', url);

  // 创建带超时的控制器
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MCP_HTTP_VERIFY_TIMEOUT);

  try {
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO
      }
    };

    // Use shared helper to sanitize headers and extract Authorization from query string
    const { fetchUrl, headers } = buildSseRequestContext(url, serverConfig);
    headers['Content-Type'] = 'application/json';
    headers['Accept'] = 'application/json, text/event-stream';

    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(initRequest),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ': ' + response.statusText);
    }

    const responseText = await response.text();

    // 首先尝试解析为 SSE 格式
    const events = parseSSE(responseText);
    let data;
    if (events.length > 0 && events[0].data) {
      data = events[0].data;
    } else {
      // 回退到 JSON 解析
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        throw new Error('Failed to parse response: ' + parseError.message);
      }
    }

    if (data.error) {
      throw new Error('Server error: ' + (data.error.message || JSON.stringify(data.error)));
    }

    // 检查是否有 serverInfo（某些服务器会返回）
    if (data.result && data.result.serverInfo) {
      result.status = 'connected';
      result.serverInfo = data.result.serverInfo;
      log('info', '[MCP Verify] HTTP/SSE server connected:', serverName);
    } else if (data.result) {
      // 服务器返回了有效的 result 但没有 serverInfo，也算连接成功
      result.status = 'connected';
      log('info', '[MCP Verify] HTTP/SSE server connected (no serverInfo):', serverName);
    } else {
      result.status = 'connected';
    }

  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      result.status = 'pending';
      result.error = 'Connection timeout';
      log('debug', `[MCP Verify] HTTP/SSE server timeout: ${serverName}`);
    } else {
      result.status = 'failed';
      result.error = error.message;
      log('debug', `[MCP Verify] HTTP/SSE server failed: ${serverName}`, error.message);
    }
  }

  return result;
}
