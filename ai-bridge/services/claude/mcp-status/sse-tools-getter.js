/**
 * SSE transport tools getter module
 * Retrieves tool lists from MCP servers using the legacy SSE transport protocol.
 *
 * Flow: GET /sse → endpoint discovery → POST initialize → POST tools/list
 *
 * IMPORTANT: The SSE stream is a single persistent connection. All responses
 * (endpoint event, initialize response, tools/list response) arrive on the
 * same stream. We must use a single reader throughout the entire lifecycle.
 */

import { MCP_SSE_TOOLS_TIMEOUT } from './config.js';
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
 * Get tools list from an SSE-type MCP server
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server configuration
 * @returns {Promise<Object>} { name, tools, error, serverType }
 */
export async function getSseServerTools(serverName, serverConfig) {
  const result = {
    name: serverName,
    tools: [],
    error: null,
    serverType: 'sse'
  };

  const url = serverConfig.url;
  if (!url) {
    return { ...result, error: 'No URL specified for SSE server' };
  }

  log('info', '[MCP Tools] Starting SSE tools fetch for:', serverName,
    'URL:', sanitizeUrlForLogging(url));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MCP_SSE_TOOLS_TIMEOUT);
  const { fetchUrl, headers } = buildSseRequestContext(url, serverConfig);

  let reader = null;

  try {
    // Step 1: Establish SSE connection
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
    log('info', '[MCP Tools] SSE endpoint discovered:', messageEndpoint);

    // Step 3: Send initialize request
    let requestId = 0;
    const initResult = await sendAndReceive(
      messageEndpoint, headers, {
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO
        }
      },
      reader, decoder, bufferRef, controller.signal
    );

    if (initResult?.error) {
      throw new Error('Initialize error: ' +
        (initResult.error.message || JSON.stringify(initResult.error)));
    }
    if (!initResult?.result) {
      throw new Error('Invalid initialize response: ' + JSON.stringify(initResult));
    }

    log('info', '[MCP Tools] SSE server initialized:', serverName);

    // Step 3.5: Send initialized notification (required by MCP protocol)
    // Non-critical: failure should not prevent subsequent tools/list request
    try {
      await fetch(messageEndpoint, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: controller.signal
      });
    } catch {
      log('debug', '[MCP Tools] initialized notification failed for', serverName, '(non-critical)');
    }

    // Step 4: Send tools/list request
    const toolsResult = await sendAndReceive(
      messageEndpoint, headers, {
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'tools/list',
        params: {}
      },
      reader, decoder, bufferRef, controller.signal
    );

    if (toolsResult?.result?.tools) {
      result.tools = toolsResult.result.tools;
      log('info', '[MCP Tools] SSE server', serverName,
        'returned', result.tools.length, 'tools');
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      log('debug', '[MCP Tools] SSE server timeout:', serverName);
      result.error = 'Connection timeout';
    } else {
      const errorMsg = error?.message || String(error);
      log('error', '[MCP Tools] SSE server', serverName, 'failed:', errorMsg);
      result.error = errorMsg;
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

/**
 * POST a JSON-RPC request and wait for the response on the SSE stream.
 * @param {string} endpoint - The POST endpoint URL
 * @param {Object} baseHeaders - Base request headers
 * @param {Object} body - JSON-RPC request body
 * @param {ReadableStreamDefaultReader} reader - SSE stream reader
 * @param {TextDecoder} decoder - Shared decoder
 * @param {{value: string}} bufferRef - Shared buffer
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<Object>} Parsed JSON-RPC response data
 */
async function sendAndReceive(endpoint, baseHeaders, body, reader, decoder, bufferRef, signal) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    throw new Error(body.method + ' POST failed: HTTP ' + response.status);
  }

  // Check if server returned JSON directly (some implementations do)
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await response.json();
  }

  // Otherwise wait for response on the SSE stream
  const event = await waitForSseEvent(
    reader, decoder, bufferRef,
    isJsonRpcResponse,
    signal
  );

  return extractJsonRpcData(event, body.method + ' response');
}
