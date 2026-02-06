/**
 * SSE transport verifier module
 * Verifies MCP servers that use the legacy SSE transport protocol.
 *
 * SSE transport flow:
 * 1. GET /sse → establish SSE event stream
 * 2. Receive "endpoint" event → extract message POST URL
 * 3. POST initialize request to the endpoint
 * 4. Read initialize response from SSE stream
 *
 * IMPORTANT: The SSE stream is a single persistent connection. All events
 * (endpoint, message responses) arrive on the same stream. We must use
 * a single reader throughout the entire lifecycle.
 */

import { MCP_SSE_VERIFY_TIMEOUT } from './config.js';
import { log } from './logger.js';
import {
  MCP_PROTOCOL_VERSION,
  MCP_CLIENT_INFO,
  resolveSseEndpointUrl,
  buildSseRequestContext,
  sanitizeUrlForLogging,
  waitForSseEvent,
  extractJsonRpcData,
  isJsonRpcResponse
} from './mcp-protocol.js';

/**
 * Verify an SSE-type MCP server by performing the full SSE handshake
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server configuration
 * @returns {Promise<Object>} Server status { name, status, serverInfo, error? }
 */
export async function verifySseServerStatus(serverName, serverConfig) {
  const result = {
    name: serverName,
    status: 'pending',
    serverInfo: null
  };

  const url = serverConfig.url;
  if (!url) {
    return { ...result, status: 'failed', error: 'No URL specified for SSE server' };
  }

  log('info', '[MCP Verify] Verifying SSE server:', serverName,
    'URL:', sanitizeUrlForLogging(url));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MCP_SSE_VERIFY_TIMEOUT);
  const { fetchUrl, headers } = buildSseRequestContext(url, serverConfig);

  let reader = null;

  try {
    // Step 1: GET the SSE endpoint to establish event stream
    const sseResponse = await fetch(fetchUrl, {
      method: 'GET',
      headers: { ...headers, 'Accept': 'text/event-stream' },
      signal: controller.signal
    });

    if (!sseResponse.ok) {
      throw new Error('SSE connection failed: HTTP ' + sseResponse.status);
    }
    if (!sseResponse.body) {
      throw new Error('SSE response has no readable body');
    }

    reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    const bufferRef = { value: '' };

    // Step 2: Wait for endpoint event
    const endpointEvent = await waitForSseEvent(
      reader, decoder, bufferRef,
      (evt) => evt.event === 'endpoint' && evt.data != null,
      controller.signal
    );

    const rawEndpoint = typeof endpointEvent.data === 'string'
      ? endpointEvent.data : String(endpointEvent.data);
    const messageEndpoint = resolveSseEndpointUrl(rawEndpoint, url);
    log('info', '[MCP Verify] SSE endpoint discovered:', messageEndpoint);

    // Step 3: POST initialize request to the discovered endpoint
    const initResponse = await fetch(messageEndpoint, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO
        }
      }),
      signal: controller.signal
    });

    if (!initResponse.ok) {
      throw new Error('Initialize POST failed: HTTP ' + initResponse.status);
    }

    // Step 4: Read initialize response
    const contentType = initResponse.headers.get('content-type') || '';
    let data = null;

    if (contentType.includes('application/json')) {
      data = await initResponse.json();
    } else {
      const initEvent = await waitForSseEvent(
        reader, decoder, bufferRef,
        isJsonRpcResponse,
        controller.signal
      );
      data = extractJsonRpcData(initEvent, 'SSE init response');
    }

    if (data?.error) {
      throw new Error('Server error: ' + (data.error.message || JSON.stringify(data.error)));
    }

    if (data?.result?.serverInfo) {
      result.serverInfo = data.result.serverInfo;
      log('info', '[MCP Verify] SSE server connected:', serverName);
    } else {
      log('info', '[MCP Verify] SSE server connected (no serverInfo):', serverName);
    }
    result.status = 'connected';
  } catch (error) {
    if (error.name === 'AbortError') {
      result.status = 'pending';
      result.error = 'Connection timeout';
      log('debug', '[MCP Verify] SSE server timeout:', serverName);
    } else {
      result.status = 'failed';
      result.error = error.message;
      log('debug', '[MCP Verify] SSE server failed:', serverName, error.message);
    }
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
    if (reader) {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  return result;
}
