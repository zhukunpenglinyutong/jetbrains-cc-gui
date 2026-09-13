import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

import { decodeFrame, DshWebSocket, encodeFrame } from './ws-client.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

test('encodeFrame/decodeFrame roundtrip with masking', () => {
  const payload = Buffer.from('{"hello":"mux"}', 'utf8');
  const encoded = encodeFrame(0x1, payload);
  const frame = decodeFrame(encoded);
  assert.ok(frame);
  assert.equal(frame.fin, true);
  assert.equal(frame.opcode, 0x1);
  assert.equal(frame.payload.toString('utf8'), payload.toString('utf8'));
  assert.equal(frame.bytesConsumed, encoded.length);
});

test('decodeFrame handles 16-bit and fragmented buffers', () => {
  const big = Buffer.alloc(1000, 0x61);
  const encoded = encodeFrame(0x2, big);
  assert.equal(decodeFrame(encoded.subarray(0, 10)), null); // incomplete
  const frame = decodeFrame(encoded);
  assert.equal(frame.payload.length, 1000);
});

test('decodeFrame unmasks server-style masked frame', () => {
  // Manually build a masked text frame "hi" with mask 01 02 03 04.
  const mask = Buffer.from([1, 2, 3, 4]);
  const raw = Buffer.from('hi');
  const masked = Buffer.from([raw[0] ^ 1, raw[1] ^ 2]);
  const buf = Buffer.concat([Buffer.from([0x81, 0x80 | 2]), mask, masked]);
  const frame = decodeFrame(buf);
  assert.equal(frame.payload.toString('utf8'), 'hi');
});

test('decodeFrame fails fast on frames over the 64MB cap', () => {
  // 8-byte length declaring 128MB — must throw instead of buffering forever.
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(128 * 1024 * 1024), 2);
  assert.throws(() => decodeFrame(header), /frame too large/);
});

test('DshWebSocket emits error (not a crash) when a frame exceeds the cap', async () => {
  const server = createServer();
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    // Server frame declaring a 128MB payload.
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(128 * 1024 * 1024), 2);
    socket.write(header);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ws = new DshWebSocket();
    const failed = new Promise((resolve, reject) => {
      ws.on('error', resolve);
      ws.on('close', () => reject(new Error('closed without error')));
    });
    ws.connect(`ws://127.0.0.1:${port}/api/events.mux`);
    const error = await failed;
    assert.match(error.message, /frame too large/);
    assert.equal(ws.isOpen, false);
  } finally {
    // Upgrade sockets are not tracked by server.close() — destroy them first.
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DshWebSocket completes handshake and exchanges messages', async () => {
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.on('data', (chunk) => {
      const frame = decodeFrame(chunk);
      if (!frame) return;
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      // Echo as an UNMASKED server frame.
      const payload = frame.payload;
      const header = Buffer.from([0x81, payload.length]);
      socket.write(Buffer.concat([header, payload]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const ws = new DshWebSocket();
    const errors = [];
    ws.on('error', (error) => errors.push(error));
    const opened = new Promise((resolve) => ws.on('open', resolve));
    ws.connect(`ws://127.0.0.1:${port}/api/events.mux`);
    await opened;
    assert.equal(ws.isOpen, true);

    const echoed = new Promise((resolve) => ws.on('message', resolve));
    assert.equal(ws.send('{"type":"ping"}'), true);
    assert.equal(await echoed, '{"type":"ping"}');
    assert.deepEqual(errors, []);
    ws.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DshWebSocket rejects a non-101 handshake', async () => {
  const server = createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ws = new DshWebSocket();
    const failed = new Promise((resolve) => {
      ws.on('error', resolve);
      ws.on('close', resolve);
    });
    ws.connect(`ws://127.0.0.1:${port}/api/events.mux`);
    await failed;
    assert.equal(ws.isOpen, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Build an unmasked server frame (FIN configurable). */
function serverFrame(opcode, payload, fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, body]);
}

/** Handshake-answering test server; `onReady(socket)` runs post-upgrade. */
async function startMuxServer(onReady) {
  const server = createServer();
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    onReady(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stop = async () => {
    // Upgrade sockets are not tracked by server.close() — destroy them first.
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  };
  return { port: server.address().port, stop };
}

function connectExpectingError(port) {
  const ws = new DshWebSocket();
  const failed = new Promise((resolve, reject) => {
    ws.on('error', resolve);
    ws.on('close', () => reject(new Error('closed without error')));
  });
  ws.connect(`ws://127.0.0.1:${port}/api/events.mux`);
  return failed;
}

test('DshWebSocket reassembles a valid fragmented message', async () => {
  const { port, stop } = await startMuxServer((socket) => {
    socket.write(serverFrame(0x1, 'hello ', false));
    socket.write(serverFrame(0x0, 'world', true));
  });
  try {
    const ws = new DshWebSocket();
    const errors = [];
    ws.on('error', (error) => errors.push(error));
    const received = new Promise((resolve) => ws.on('message', resolve));
    ws.connect(`ws://127.0.0.1:${port}/api/events.mux`);
    assert.equal(await received, 'hello world');
    assert.deepEqual(errors, []);
    ws.close();
  } finally {
    await stop();
  }
});

test('DshWebSocket fails on a continuation frame with no fragmented message', async () => {
  const { port, stop } = await startMuxServer((socket) => {
    socket.write(serverFrame(0x0, 'orphan', true));
  });
  try {
    const error = await connectExpectingError(port);
    assert.match(error.message, /unexpected continuation frame/);
  } finally {
    await stop();
  }
});

test('DshWebSocket fails when a data frame interrupts a fragmented message', async () => {
  const { port, stop } = await startMuxServer((socket) => {
    socket.write(serverFrame(0x1, 'partial', false));
    socket.write(serverFrame(0x1, 'interloper', true));
  });
  try {
    const error = await connectExpectingError(port);
    assert.match(error.message, /new data frame during fragmented message/);
  } finally {
    await stop();
  }
});

test('DshWebSocket fails when aggregated fragments exceed the 64MB cap', async () => {
  // Each frame stays under the per-frame cap; the aggregate must still fail.
  const chunk = Buffer.alloc(33 * 1024 * 1024, 0x61);
  const { port, stop } = await startMuxServer((socket) => {
    socket.write(serverFrame(0x1, chunk, false));
    socket.write(serverFrame(0x0, chunk, false));
  });
  try {
    const error = await connectExpectingError(port);
    assert.match(error.message, /fragmented message too large/);
  } finally {
    await stop();
  }
});
