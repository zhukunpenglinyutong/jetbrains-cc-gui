/**
 * DSH Host RPC unary client (ported from desktop-cc-gui engine/dsh/host.rs).
 *
 * Wire: `POST /api/<method>` with
 *   {type:"client-request",rpcId,method,payload}
 *   → {type:"server-response",rpcId,result:{ok:true,value}|{ok:false,error}}.
 *
 * Two dialects share that envelope (see ./wire.js):
 *   legacy  `POST /api/session.list`, payload is the business object, `/api`
 *           is unauthenticated.
 *   modern  `POST /api/session/list`, payload is `{args:{request|_request}}`,
 *           every request carries the browser-session cookie.
 *
 * Host-minted requests (approvals / questions) settle on `POST /api/respond`
 * (legacy, echoing the rpcId) or on `POST /api/$events/result` (modern,
 * quoting the `clientId` + `eventId` of the waterfall frame).
 */

import { randomUUID } from 'node:crypto';
import {
  LEGACY_DIALECT,
  MODERN_DIALECT,
  muxPathFor,
  requiresBrowserSession,
  respondPathFor,
  rpcPayloadFor,
  wireMethodFor,
} from './wire.js';

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

/** Transport failure carrying the HTTP status, so callers can react to 401. */
export class DshHttpError extends DshTransportError {
  constructor(status, message) {
    super(message);
    this.name = 'DshHttpError';
    this.status = status;
  }
}

export function originFromHostPort(host, port) {
  const trimmedHost = String(host || '127.0.0.1').trim() || '127.0.0.1';
  const numericPort = Number(port) > 0 ? Number(port) : 3080;
  return `http://${trimmedHost}:${numericPort}`;
}

/**
 * @param {string} origin canonical `http://host:port`
 * @param {string} [muxPath] dialect mux pathname (defaults to the legacy one)
 */
export function muxUrlFromOrigin(origin, muxPath = muxPathFor(LEGACY_DIALECT)) {
  const trimmed = String(origin || '').replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}${muxPath}`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}${muxPath}`;
  }
  return `ws://${trimmed}${muxPath}`;
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

async function postJson(url, body, timeoutMs, cookie) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: cookie
        ? { 'content-type': 'application/json', cookie }
        : { 'content-type': 'application/json' },
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
    throw new DshHttpError(response.status, `dsh HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

/**
 * Unary client for one host. `dialect` and `cookie` come from the supervisor's
 * negotiation (./supervisor.js); a bare `new DshHostClient(origin)` speaks the
 * legacy dialect without authentication, which is what pre-0.1.1 hosts need.
 */
export class DshHostClient {
  #dialect;
  #cookie;

  constructor(origin, options = {}) {
    this.origin = String(origin || '').replace(/\/+$/, '');
    this.#dialect = options.dialect || LEGACY_DIALECT;
    this.#cookie = options.cookie || null;
  }

  get dialect() {
    return this.#dialect;
  }

  get cookie() {
    return this.#cookie;
  }

  /** Whether removing authentication would change this client's behavior. */
  get authenticated() {
    return requiresBrowserSession(this.#dialect);
  }

  muxUrl() {
    return muxUrlFromOrigin(this.origin, muxPathFor(this.#dialect));
  }

  /** Headers the mux upgrade must carry on this dialect. */
  muxHeaders() {
    return this.#cookie ? { cookie: this.#cookie } : {};
  }

  async describe() {
    if (this.#dialect === MODERN_DIALECT) {
      // Modern hosts have no `host.describe`; the catalog's `default` selection
      // is the equivalent fact and it also carries the reasoning effort.
      const catalog = await this.call('llm.models', {}, DESCRIBE_TIMEOUT_MS);
      const fallback = catalog && typeof catalog === 'object' ? catalog.default : null;
      return fallback && typeof fallback === 'object' ? fallback : {};
    }
    return this.call('host.describe', {}, DESCRIBE_TIMEOUT_MS);
  }

  async call(method, payload = {}, timeoutMs = RPC_TIMEOUT_MS) {
    const wireMethod = wireMethodFor(this.#dialect, method);
    if (wireMethod === null) {
      throw new DshTransportError(`dsh ${method} is not available on this host`);
    }
    const rpcId = randomUUID();
    const body = {
      type: 'client-request',
      rpcId,
      method: wireMethod,
      payload: rpcPayloadFor(this.#dialect, wireMethod, payload),
    };
    const text = await postJson(
      `${this.origin}/api/${wireMethod}`,
      body,
      timeoutMs,
      this.#cookie
    );
    return parseServerResponse(text, rpcId, wireMethod);
  }

  /**
   * Settle a host-minted server-request (approval / question) on the legacy
   * wire, which correlates the reply by the frame's rpcId.
   */
  async respond(rpcId, value) {
    const body = {
      type: 'client-response',
      rpcId,
      result: { ok: true, value },
    };
    const text = await postJson(
      `${this.origin}${respondPathFor(this.#dialect)}`,
      body,
      RPC_TIMEOUT_MS,
      this.#cookie
    );
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new DshTransportError(`dsh respond json: ${error.message}`);
    }
  }

  /**
   * Settle one modern waterfall frame. The host routes the answer by
   * `clientId` + `eventId` (both minted per generation), and the result is a
   * unary RPC on `$events/result` — the mux socket never carries results.
   *
   * @param {string} clientId - id from the `$events` opening `ready` frame.
   * @param {string} eventId - waterfall frame identity.
   * @param {unknown} value - approval outcome or question answer.
   */
  async answerRemoteEvent(clientId, eventId, value) {
    const rpcId = randomUUID();
    const wireMethod = wireMethodFor(this.#dialect, '$events/result') || '$events/result';
    const body = {
      type: 'client-request',
      rpcId,
      method: wireMethod,
      payload: { args: { clientId, eventId, outcome: { kind: 'result', value } } },
    };
    const text = await postJson(
      `${this.origin}/api/${wireMethod}`,
      body,
      RPC_TIMEOUT_MS,
      this.#cookie
    );
    return parseServerResponse(text, rpcId, wireMethod);
  }
}

/** Probe `host.describe` on a legacy host; resolves with the describe value. */
export async function probeDescribe(origin, timeoutMs = DESCRIBE_TIMEOUT_MS) {
  const client = new DshHostClient(origin);
  return client.call('host.describe', {}, timeoutMs);
}
