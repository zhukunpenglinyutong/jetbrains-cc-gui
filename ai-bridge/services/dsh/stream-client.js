/**
 * Modern DSH Remote stream client (`dsh >= 0.1.5`).
 *
 * The host multiplexes every logical stream over one WebSocket at
 * `/api/remote.mux`, and the socket is bidirectional:
 *
 *   client → host   {type:'open', streamId, endpoint, payload:{args}}
 *                   {type:'cancel', streamId}
 *   host → client   {type:'item', streamId, value?}
 *                   {type:'error', streamId, error:{code,message,details}}
 *                   {type:'end', streamId}
 *
 * `endpoint` is a Remote `<namespace>/<method>` (or the gateway-internal
 * `$events`), `streamId` is minted by this client, and nothing is delivered
 * until the matching `open` frame is sent — the old server-push-only mux
 * (`/api/events.mux`) has no equivalent here.
 *
 * The host authenticates the upgrade with the browser-session cookie and
 * drives a protocol-level WebSocket ping every couple of seconds; `DshWebSocket`
 * already answers pings with pongs and must not be given an application-level
 * keepalive instead.
 */

import { randomUUID } from 'node:crypto';
import { DshWebSocket } from './ws-client.js';

/** Endpoint carrying forwarded Cordis events (approvals, questions, session list changes). */
export const REMOTE_EVENTS_ENDPOINT = '$events';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/**
 * One consumer of a logical stream. `onValue` receives the frame's `value`;
 * a frame without `value` is delivered as undefined so a keepalive `item`
 * still counts as liveness.
 */
function normalizeHandlers(handlers = {}) {
  return {
    onValue: typeof handlers.onValue === 'function' ? handlers.onValue : () => {},
    onError: typeof handlers.onError === 'function' ? handlers.onError : () => {},
    onEnd: typeof handlers.onEnd === 'function' ? handlers.onEnd : () => {},
    onOpen: typeof handlers.onOpen === 'function' ? handlers.onOpen : () => {},
  };
}

/** Whether a value looks like a valid stream frame for `streamId`. */
function frameFor(frame, streamId) {
  if (!frame || typeof frame !== 'object' || frame.streamId !== streamId) {
    return null;
  }
  const type = typeof frame.type === 'string' ? frame.type : '';
  return type === 'item' || type === 'error' || type === 'end' ? type : null;
}

export class DshRemoteMux {
  #url;
  #headers;
  #log;
  #ws = null;
  #stopped = false;
  #open = false;
  #retry = 0;
  #retryTimer = null;
  #openListeners = [];
  /** streamId → { endpoint, args, sessionId, handlers } */
  #streams = new Map();

  /**
   * @param {string} url ws:// or wss:// URL of `/api/remote.mux`
   * @param {{ headers?: Record<string,string>, log?: Function }} [options]
   */
  constructor(url, options = {}) {
    this.#url = url;
    this.#headers = options.headers || {};
    this.#log = typeof options.log === 'function' ? options.log : () => {};
  }

  connect() {
    if (this.#stopped || this.#ws) {
      return;
    }
    const ws = new DshWebSocket();
    this.#ws = ws;
    ws.on('error', (error) => {
      this.#log(`[dsh] mux error: ${error.message}`);
    });
    ws.on('open', () => {
      this.#open = true;
      this.#retry = 0;
      this.#log(`[dsh] mux connected ${this.#url}`);
      this.#resubscribe();
      const listeners = this.#openListeners.splice(0);
      for (const listener of listeners) {
        listener();
      }
    });
    ws.on('message', (text) => this.#onMessage(text));
    ws.on('close', () => {
      this.#open = false;
      this.#ws = null;
      if (this.#stopped) {
        return;
      }
      for (const entry of this.#streams.values()) {
        entry.handlers.onEnd();
      }
      this.#retry += 1;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, this.#retry - 1));
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        this.connect();
      }, delay);
    });
    ws.connect(this.#url, { headers: this.#headers });
  }

  /** Resolve once the socket is open (immediately when already open). */
  whenOpen() {
    if (this.#open) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#openListeners.push(resolve);
    });
  }

  /**
   * Open one logical stream. The returned handle keeps the stream registered
   * for reconnect replay; call `cancel()` to end it.
   *
   * @param {string} endpoint Remote endpoint (`session/follow`, `$events`, …)
   * @param {object} args business arguments (wrapped in the required `args` payload)
   * @param {object} handlers onValue/onError/onEnd/onOpen
   * @returns {{ id: string, cancel: () => void }}
   */
  open(endpoint, args = {}, handlers = {}) {
    const streamId = randomUUID();
    const entry = {
      endpoint: String(endpoint || ''),
      args: args && typeof args === 'object' ? args : {},
      handlers: normalizeHandlers(handlers),
    };
    this.#streams.set(streamId, entry);
    this.#sendOpen(streamId, entry);
    return {
      id: streamId,
      cancel: () => this.cancel(streamId),
    };
  }

  cancel(streamId) {
    if (!this.#streams.delete(streamId)) {
      return;
    }
    if (this.#open && this.#ws) {
      this.#ws.send(JSON.stringify({ type: 'cancel', streamId }));
    }
  }

  close() {
    this.#stopped = true;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#openListeners.splice(0).forEach((resolve) => resolve());
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    for (const entry of streams) {
      entry.handlers.onEnd();
    }
    this.#open = false;
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  #sendOpen(streamId, entry) {
    if (!this.#open || !this.#ws) {
      return;
    }
    // Exactly these four keys: an unknown key is a protocol violation the
    // host answers by closing the whole socket (1008).
    this.#ws.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: entry.endpoint,
      payload: { args: entry.args },
    }));
    entry.handlers.onOpen();
  }

  #resubscribe() {
    for (const [streamId, entry] of this.#streams) {
      this.#sendOpen(streamId, entry);
    }
  }

  #onMessage(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    const streamId = frame && typeof frame.streamId === 'string' ? frame.streamId : '';
    const entry = this.#streams.get(streamId);
    if (!entry) {
      return;
    }
    switch (frameFor(frame, streamId)) {
      case 'item':
        entry.handlers.onValue(frame.value);
        break;
      case 'error': {
        const error = frame.error && typeof frame.error === 'object' ? frame.error : {};
        entry.handlers.onError(new Error(
          typeof error.message === 'string' ? error.message : 'dsh Remote stream failed',
          { cause: error }
        ));
        break;
      }
      case 'end':
        entry.handlers.onEnd();
        break;
      default:
        break;
    }
  }
}
