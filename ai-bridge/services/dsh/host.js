/**
 * DSH Host RPC unary client (ported from desktop-cc-gui engine/dsh/host.rs).
 *
 * Wire: `POST /api/<method>` with
 *   {type:"client-request",rpcId,method,payload}
 *   → {type:"server-response",rpcId,result:{ok:true,value}|{ok:false,error}}.
 * Approvals / questions settle via `POST /api/respond` with a
 * `client-response` envelope carrying the same rpcId.
 */

import { randomUUID } from 'node:crypto';

const RPC_TIMEOUT_MS = 30_000;
const DESCRIBE_TIMEOUT_MS = 3_000;

export class DshRpcError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DshRpcError';
    this.code = code;
    this.details = details;
  }
}

export class DshTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DshTransportError';
  }
}

export function originFromHostPort(host, port) {
  const trimmedHost = String(host || '127.0.0.1').trim() || '127.0.0.1';
  const numericPort = Number(port) > 0 ? Number(port) : 3080;
  return `http://${trimmedHost}:${numericPort}`;
}

export function muxUrlFromOrigin(origin) {
  const trimmed = String(origin || '').replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}/api/events.mux`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}/api/events.mux`;
  }
  return `ws://${trimmed}/api/events.mux`;
}

/**
 * Parse a `server-response` body. Throws DshTransportError on envelope
 * violations and DshRpcError on `{ok:false}` business failures.
 */
export function parseServerResponse(text, expectedRpcId, method) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new DshTransportError(`dsh ${method} envelope: ${error.message}`);
  }
  if (!envelope || envelope.type !== 'server-response') {
    throw new DshTransportError(
      `dsh ${method}: expected server-response, got ${envelope && envelope.type}`
    );
  }
  if (envelope.rpcId && expectedRpcId && envelope.rpcId !== expectedRpcId) {
    throw new DshTransportError(
      `dsh ${method}: rpcId mismatch (${envelope.rpcId} != ${expectedRpcId})`
    );
  }
  const result = envelope.result;
  if (!result || typeof result !== 'object') {
    throw new DshTransportError(`dsh ${method}: missing result`);
  }
  if (result.ok === true) {
    return result.value;
  }
  const rpcError = result.error && typeof result.error === 'object' ? result.error : {};
  throw new DshRpcError(
    typeof rpcError.code === 'string' ? rpcError.code : 'unknown',
    typeof rpcError.message === 'string' ? rpcError.message : 'unknown DSH error',
    rpcError.details && typeof rpcError.details === 'object' ? rpcError.details : {}
  );
}

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new DshTransportError(`dsh ${body.method || 'request'} timed out`);
    }
    throw new DshTransportError(`dsh transport: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new DshTransportError(`dsh HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

export class DshHostClient {
  constructor(origin) {
    this.origin = String(origin || '').replace(/\/+$/, '');
  }

  muxUrl() {
    return muxUrlFromOrigin(this.origin);
  }

  async describe() {
    return this.call('host.describe', {}, DESCRIBE_TIMEOUT_MS);
  }

  async call(method, payload = {}, timeoutMs = RPC_TIMEOUT_MS) {
    const rpcId = randomUUID();
    const body = { type: 'client-request', rpcId, method, payload };
    const text = await postJson(`${this.origin}/api/${method}`, body, timeoutMs);
    return parseServerResponse(text, rpcId, method);
  }

  /**
   * Settle a host-minted server-request (approval / question).
   */
  async respond(rpcId, value) {
    const body = {
      type: 'client-response',
      rpcId,
      result: { ok: true, value },
    };
    const text = await postJson(`${this.origin}/api/respond`, body, RPC_TIMEOUT_MS);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new DshTransportError(`dsh respond json: ${error.message}`);
    }
  }
}

/** Probe `host.describe`; resolves with the describe value or rejects. */
export async function probeDescribe(origin, timeoutMs = DESCRIBE_TIMEOUT_MS) {
  const client = new DshHostClient(origin);
  return client.call('host.describe', {}, timeoutMs);
}
