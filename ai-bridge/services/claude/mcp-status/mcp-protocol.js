/**
 * MCP 协议工具模块
 * 提供 MCP 协议相关的工具函数
 */

/** MCP protocol version used for initialize handshake */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Client info sent during MCP initialize */
export const MCP_CLIENT_INFO = Object.freeze({
  name: 'codemoss-ide',
  version: '1.0.0'
});

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
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO
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

    if (trimmedLine === '') {
      if (Object.keys(currentEvent).length > 0) {
        events.push(currentEvent);
        currentEvent = {};
      }
    } else {
      currentEvent = parseSseLine(trimmedLine, currentEvent);
    }
  }

  // Don't forget the last event if there's no trailing newline
  if (Object.keys(currentEvent).length > 0) {
    events.push(currentEvent);
  }

  return events;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Resolve an SSE endpoint URL (may be relative or absolute).
 * Enforces same-origin and protocol whitelist to prevent SSRF.
 * @param {string} endpointUrl - The endpoint URL from the SSE event
 * @param {string} sseUrl - The original SSE URL used for connection
 * @returns {string} Fully resolved absolute URL
 */
export function resolveSseEndpointUrl(endpointUrl, sseUrl) {
  const base = new URL(sseUrl);

  let resolved;
  try {
    resolved = new URL(endpointUrl);
  } catch {
    // Relative path — resolve against the full SSE URL for correct path resolution
    resolved = new URL(endpointUrl, sseUrl);
  }

  // Enforce protocol whitelist
  if (!ALLOWED_PROTOCOLS.has(resolved.protocol)) {
    throw new Error(
      `SSE endpoint uses unsupported protocol: ${resolved.protocol}`
    );
  }

  // Enforce same-origin to prevent SSRF via malicious endpoint redirect
  if (resolved.origin !== base.origin) {
    throw new Error(
      `SSE endpoint origin mismatch: expected ${base.origin}, got ${resolved.origin}`
    );
  }

  return resolved.toString();
}

/**
 * Sanitize a URL for safe logging by redacting sensitive query parameters.
 * @param {string} url - Original URL
 * @returns {string} URL safe for logging
 */
export function sanitizeUrlForLogging(url) {
  try {
    const urlObj = new URL(url);
    const sensitiveKeys = new Set(['authorization', 'token', 'key', 'secret', 'api_key', 'apikey', 'password']);
    for (const [key] of urlObj.searchParams) {
      if (sensitiveKeys.has(key.toLowerCase())) {
        urlObj.searchParams.set(key, '[REDACTED]');
      }
    }
    return urlObj.toString();
  } catch {
    return url;
  }
}

// Headers that must not be overridden by user config
const FORBIDDEN_HEADERS = new Set([
  'host', 'transfer-encoding', 'connection',
  'keep-alive', 'upgrade', 'proxy-authorization',
  'te', 'trailer'
]);

/**
 * Filter user-provided headers, removing forbidden ones.
 * @param {Object} rawHeaders - Headers from server config
 * @returns {Object} Sanitized headers
 */
function sanitizeHeaders(rawHeaders) {
  const safe = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value !== 'string') continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Build request headers, extracting Authorization from query string if present.
 * Shared by SSE verifier and SSE tools getter.
 * @param {string} url - Original URL
 * @param {Object} serverConfig - Server configuration
 * @returns {{fetchUrl: string, headers: Object}}
 */
export function buildSseRequestContext(url, serverConfig) {
  const headers = sanitizeHeaders(serverConfig.headers || {});

  let fetchUrl = url;
  try {
    const urlObj = new URL(url);
    const authParam = urlObj.searchParams.get('Authorization');
    if (authParam) {
      headers['Authorization'] = authParam;
      urlObj.searchParams.delete('Authorization');
      fetchUrl = urlObj.toString();
    }
  } catch {
    // Invalid URL, use original
  }

  return { fetchUrl, headers };
}

/**
 * Parse a single SSE line and return a new event object with the parsed field merged.
 * Immutable: does not modify the input currentEvent.
 * @param {string} line - A single line from the SSE stream
 * @param {Object} currentEvent - The event being built
 * @returns {Object} New event object with the parsed field
 */
export function parseSseLine(line, currentEvent) {
  if (line.startsWith('event:')) {
    const event = line.startsWith('event: ')
      ? line.substring(7) : line.substring(6);
    return { ...currentEvent, event };
  }

  if (line.startsWith('data:')) {
    const raw = line.startsWith('data: ')
      ? line.substring(6) : line.substring(5);
    try {
      return { ...currentEvent, data: JSON.parse(raw) };
    } catch {
      return { ...currentEvent, data: raw };
    }
  }

  if (line.startsWith('id:')) {
    const id = line.startsWith('id: ')
      ? line.substring(4) : line.substring(3);
    return { ...currentEvent, id };
  }

  return currentEvent;
}

/** Maximum buffer size (1 MB) to prevent memory exhaustion from malicious streams */
const MAX_SSE_BUFFER_SIZE = 1024 * 1024;

/** Maximum number of non-matching events before giving up */
const MAX_SSE_EVENT_COUNT = 1000;

/**
 * Wait for the next SSE event matching a predicate from a persistent reader.
 * Reads from the stream incrementally, buffering partial lines.
 *
 * @param {ReadableStreamDefaultReader} reader - The stream reader
 * @param {TextDecoder} decoder - Shared decoder instance
 * @param {{value: string}} bufferRef - Mutable shared buffer.
 *   Intentionally mutable: the buffer must persist across multiple
 *   waitForSseEvent calls on the same SSE stream.
 * @param {function(Object): boolean} predicate - Return true to accept the event
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<Object>} The matching SSE event
 */
export async function waitForSseEvent(reader, decoder, bufferRef, predicate, signal) {
  let currentEvent = {};
  let eventCount = 0;

  while (!signal.aborted) {
    let newlineIdx;
    while ((newlineIdx = bufferRef.value.indexOf('\n')) !== -1) {
      const line = bufferRef.value.slice(0, newlineIdx).replace(/\r$/, '');
      bufferRef.value = bufferRef.value.slice(newlineIdx + 1);

      if (line === '') {
        if (Object.keys(currentEvent).length > 0) {
          if (predicate(currentEvent)) {
            return currentEvent;
          }
          currentEvent = {};
          eventCount++;
          if (eventCount >= MAX_SSE_EVENT_COUNT) {
            throw new Error('Exceeded maximum event count without matching predicate');
          }
        }
        continue;
      }

      currentEvent = parseSseLine(line, currentEvent);
    }

    const { done, value } = await reader.read();
    if (done) break;

    bufferRef.value += decoder.decode(value, { stream: true });
    if (bufferRef.value.length > MAX_SSE_BUFFER_SIZE) {
      throw new Error('SSE buffer exceeded maximum size');
    }
  }

  throw new Error('Stream ended without matching event');
}

/**
 * Extract JSON-RPC data from an SSE event's data field.
 * @param {Object} event - The SSE event
 * @param {string} context - Description for error messages
 * @returns {Object} Parsed JSON-RPC data
 */
export function extractJsonRpcData(event, context = 'SSE response') {
  if (typeof event.data === 'object') {
    return event.data;
  }
  try {
    return JSON.parse(event.data);
  } catch {
    throw new Error(
      'Failed to parse ' + context + ': ' + String(event.data).slice(0, 200)
    );
  }
}

/** Predicate that matches JSON-RPC responses (have "id"), skipping notifications */
export function isJsonRpcResponse(evt) {
  if (evt.event !== 'message' || evt.data == null) return false;
  let d = evt.data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return false; }
  }
  if (typeof d !== 'object' || d === null) return false;
  return d.id != null;
}
