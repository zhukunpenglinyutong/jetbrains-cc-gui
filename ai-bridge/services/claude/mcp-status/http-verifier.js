/**
 * HTTP/SSE server verification module
 * Provides connection status verification for HTTP/SSE-based MCP servers
 */

import { MCP_HTTP_VERIFY_TIMEOUT } from './config.js';
import { log } from './logger.js';
import { parseSSE, MCP_PROTOCOL_VERSION, MCP_CLIENT_INFO, buildSseRequestContext } from './mcp-protocol.js';

/**
 * Verify the connection status of an HTTP/SSE-based MCP server
 * Performs a basic MCP initialization handshake to check server availability
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server configuration
 * @returns {Promise<Object>} Server status info
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

  // Create an abort controller with timeout
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

    // Try parsing as SSE format first
    const events = parseSSE(responseText);
    let data;
    if (events.length > 0 && events[0].data) {
      data = events[0].data;
    } else {
      // Fall back to JSON parsing
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        throw new Error('Failed to parse response: ' + parseError.message);
      }
    }

    if (data.error) {
      throw new Error('Server error: ' + (data.error.message || JSON.stringify(data.error)));
    }

    // Check for serverInfo (some servers include it)
    if (data.result && data.result.serverInfo) {
      result.status = 'connected';
      result.serverInfo = data.result.serverInfo;
      log('info', '[MCP Verify] HTTP/SSE server connected:', serverName);
    } else if (data.result) {
      // Server returned a valid result without serverInfo -- still counts as connected
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
