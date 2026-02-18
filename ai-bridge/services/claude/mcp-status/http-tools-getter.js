/**
 * HTTP/SSE tools retrieval module
 * Provides tool listing from HTTP/SSE-based MCP servers
 */

import { log } from './logger.js';
import { parseSSE } from './mcp-protocol.js';

/**
 * Retrieve the tool list from an HTTP/SSE-based server
 * Supports MCP Streamable HTTP session management (Mcp-Session-Id)
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server configuration
 * @returns {Promise<Object>} Tools list response
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
   * Send an MCP request with session management and retry support
   * @param {string} method - MCP method name
   * @param {Object} params - Request parameters
   * @param {number} retryCount - Current retry attempt
   * @returns {Promise<Object>} Response data
   */
  const sendRequest = async (method, params = {}, retryCount = 0) => {
    const id = ++requestId;
    const request = {
      jsonrpc: '2.0',
      id: id,
      method: method,
      params: params
    };

    // Build request headers, including session ID if available
    const headers = { ...baseHeaders };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
      log('debug', '[MCP Tools] Including session ID:', sessionId);
    }

    log('info', '[MCP Tools] ' + serverName + ' sending ' + method + ' request (id: ' + id + ')');

    // Exponential backoff timeout: 10s first try, 15s second, 20s third
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
        // 404 or 405 may indicate a legacy SSE transport that needs special handling
        if (response.status === 404 || response.status === 405) {
          log('warn', '[MCP Tools] Server returned ' + response.status + ', may be using legacy SSE transport');
        }
        throw new Error('HTTP ' + response.status + ': ' + response.statusText);
      }

      // Extract session ID from response headers
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
          // Retry on session-related errors
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
          // Retry on session-related errors
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
      // Retry on network errors
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
    // Send the initialize request
    const initResponse = await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codemoss-ide', version: '1.0.0' }
    });

    if (!initResponse.result) {
      throw new Error('Invalid initialize response: missing result');
    }

    log('info', '[MCP Tools] ' + serverName + ' initialized successfully');

    // If we have a session ID, the session is now established and subsequent requests will reuse it
    if (sessionId) {
      log('info', '[MCP Tools] Using session:', sessionId);
    }

    // Send the tools/list request (now includes the session ID)
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
