/**
 * Minimal RFC 6455 WebSocket client for the DSH mux stream.
 *
 * The published `dsh web` host (0.1.0-rc.6) serves `/api/events.mux` over
 * WebSocket only — a bare GET answers `426 Upgrade Required`. Node's global
 * WebSocket is unavailable before v22, so this dependency-free client speaks
 * just enough of the protocol for a localhost text stream:
 *   - HTTP Upgrade handshake with Sec-WebSocket-Accept validation
 *   - text / binary / continuation frames, ping → pong, close
 *   - client-side masking (required by RFC)
 *   - ws:// via net, wss:// via tls
 */

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A single frame larger than this is a broken/hostile peer — fail, don't buffer. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

export class DshWebSocket extends EventEmitter {
  #socket = null;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOpcode = 0;
  #fragmentBytes = 0;
  #handshakeDone = false;
  #handshakeBuffer = Buffer.alloc(0);
  #closed = false;

  /**
   * @param {string} url ws:// or wss:// URL
   * @param {{ timeoutMs?: number }} [options]
   */
  connect(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      queueMicrotask(() => this.emit('error', new Error(`invalid WebSocket URL: ${url}`)));
      return this;
    }
    const secure = parsed.protocol === 'wss:';
    const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
    const host = parsed.hostname;
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const key = randomBytes(16).toString('base64');

    const onConnect = () => {
      const request =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n';
      this.#socket.write(request);
    };

    this.#socket = secure
      ? tls.connect({ host, port, servername: host }, onConnect)
      : net.connect({ host, port }, onConnect);

    this.#socket.setTimeout(timeoutMs, () => {
      this.#fail(new Error('dsh mux WebSocket timed out'));
    });

    this.#socket.on('data', (chunk) => this.#onData(chunk, key));
    this.#socket.on('error', (error) => this.#fail(error));
    this.#socket.on('close', () => {
      if (!this.#closed) {
        this.#closed = true;
        this.emit('close');
      }
    });
    return this;
  }

  send(text) {
    if (this.#closed || !this.#socket || !this.#handshakeDone) {
      return false;
    }
    this.#socket.write(encodeFrame(OPCODES.TEXT, Buffer.from(String(text), 'utf8')));
    return true;
  }

  close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      if (this.#socket && this.#handshakeDone) {
        this.#socket.write(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
      }
      this.#socket?.destroy();
    } catch {
      // already gone
    }
    this.emit('close');
  }

  get isOpen() {
    return !this.#closed && this.#handshakeDone;
  }

  #fail(error) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.emit('error', error);
    try {
      this.#socket?.destroy();
    } catch {
      // ignore
    }
    this.emit('close');
  }

  #onData(chunk, key) {
    // Any decode/protocol error must surface as 'error' + 'close', never as an
    // uncaught exception inside the socket 'data' callback.
    try {
      if (!this.#handshakeDone) {
        this.#handshakeBuffer = Buffer.concat([this.#handshakeBuffer, chunk]);
        const headerEnd = this.#handshakeBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          if (this.#handshakeBuffer.length > 16 * 1024) {
            this.#fail(new Error('dsh mux handshake header too large'));
          }
          return;
        }
        const header = this.#handshakeBuffer.subarray(0, headerEnd).toString('latin1');
        const rest = this.#handshakeBuffer.subarray(headerEnd + 4);
        if (!this.#validateHandshake(header, key)) {
          return;
        }
        this.#handshakeDone = true;
        this.#socket.setTimeout(0);
        this.emit('open');
        if (rest.length > 0) {
          this.#buffer = Buffer.concat([this.#buffer, rest]);
          this.#drainFrames();
        }
        return;
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drainFrames();
    } catch (error) {
      this.#fail(error);
    }
  }

  #validateHandshake(header, key) {
    const statusLine = header.split('\r\n', 1)[0] || '';
    const statusMatch = statusLine.match(/^HTTP\/\d\.\d (\d{3})/);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status !== 101) {
      this.#fail(new Error(`dsh mux upgrade failed (HTTP ${status || statusLine})`));
      return false;
    }
    const acceptMatch = header.match(/sec-websocket-accept:\s*(\S+)/i);
    const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
    if (!acceptMatch || acceptMatch[1] !== expected) {
      this.#fail(new Error('dsh mux upgrade failed (bad Sec-WebSocket-Accept)'));
      return false;
    }
    return true;
  }

  #drainFrames() {
    for (;;) {
      const frame = decodeFrame(this.#buffer);
      if (!frame) {
        return;
      }
      this.#buffer = this.#buffer.subarray(frame.bytesConsumed);
      this.#handleFrame(frame);
      if (this.#closed) {
        return;
      }
    }
  }

  #handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODES.TEXT:
      case OPCODES.BINARY:
        if (this.#fragmentOpcode !== 0) {
          this.#fail(new Error('dsh mux new data frame during fragmented message'));
          return;
        }
        if (frame.fin) {
          this.emit('message', frame.payload.toString('utf8'));
        } else {
          this.#fragments = [frame.payload];
          this.#fragmentBytes = frame.payload.length;
          this.#fragmentOpcode = frame.opcode;
        }
        break;
      case OPCODES.CONTINUATION:
        if (this.#fragmentOpcode === 0) {
          this.#fail(new Error('dsh mux unexpected continuation frame'));
          return;
        }
        // Per-frame caps alone don't bound a never-finished fragmented
        // message — cap the aggregate too.
        this.#fragmentBytes += frame.payload.length;
        if (this.#fragmentBytes > MAX_FRAME_BYTES) {
          this.#fail(new Error('dsh mux fragmented message too large'));
          return;
        }
        this.#fragments.push(frame.payload);
        if (frame.fin) {
          const full = Buffer.concat(this.#fragments);
          this.#fragments = [];
          this.#fragmentBytes = 0;
          this.#fragmentOpcode = 0;
          this.emit('message', full.toString('utf8'));
        }
        break;
      case OPCODES.PING:
        if (!this.#closed && this.#socket) {
          this.#socket.write(encodeFrame(OPCODES.PONG, frame.payload));
        }
        break;
      case OPCODES.PONG:
        break;
      case OPCODES.CLOSE:
        if (!this.#closed) {
          this.#closed = true;
          try {
            this.#socket?.write(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
            this.#socket?.destroy();
          } catch {
            // ignore
          }
          this.emit('close');
        }
        break;
      default:
        break;
    }
  }
}

/**
 * Decode one frame from the head of `buffer`.
 * Returns null when the buffer does not yet hold a complete frame.
 */
export function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const b0 = buffer[0];
  const b1 = buffer[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('dsh mux frame too large');
    }
    length = Number(big);
    offset += 8;
  }
  if (length > MAX_FRAME_BYTES) {
    throw new Error(`dsh mux frame too large (${length} bytes)`);
  }
  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) {
    return null;
  }
  let payload = buffer.subarray(offset, offset + length);
  if (maskKey) {
    const unmasked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) {
      unmasked[i] = payload[i] ^ maskKey[i & 3];
    }
    payload = unmasked;
  }
  return { fin, opcode, payload, bytesConsumed: offset + length };
}

/** Encode a client frame (always masked, per RFC 6455 §5.3). */
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) {
    masked[i] = body[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, mask, masked]);
}
