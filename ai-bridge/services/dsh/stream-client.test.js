import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

import { DshRemoteMux } from './stream-client.js';
import { decodeFrame, DshWebSocket, encodeFrame } from './ws-client.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_TEXT = 0x1;

/**
 * A stub `/api/remote.mux` host: completes the upgrade, records every client
 * frame, and exposes `send(value)` to push a text frame to the client.
 */
async function stubMux(onOpenFrame = () => {}) {
  const sockets = new Set();
  const received = [];
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    req.headers.seen = true;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) {
          return;
        }
        buffer = buffer.subarray(frame.bytesConsumed);
        if (frame.opcode !== OPCODE_TEXT) {
          continue;
        }
        const message = JSON.parse(frame.payload.toString('utf8'));
        received.push(message);
        onOpenFrame(message, socket);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `ws://127.0.0.1:${port}/api/remote.mux`,
    received,
    headers: [],
    send(socket, value) {
      socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(value), 'utf8')));
    },
    /** Push a frame to every connected socket. */
    broadcast(value) {
      for (const socket of sockets) {
        this.send(socket, value);
      }
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(resolve);
      }),
  };
}

function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('open sends exactly the four protocol keys and routes item frames', async () => {
  const host = await stubMux();
  const mux = new DshRemoteMux(host.url);
  const values = [];
  try {
    mux.connect();
    await mux.whenOpen();
    mux.open('$events', {}, { onValue: (value) => values.push(value) });

    await waitFor(() => host.received.length === 1);
    const frame = host.received[0];
    assert.deepEqual(Object.keys(frame).sort(), ['endpoint', 'payload', 'streamId', 'type']);
    assert.equal(frame.type, 'open');
    assert.equal(frame.endpoint, '$events');
    // An extra key here makes the host close the whole socket with 1008.
    assert.deepEqual(frame.payload, { args: {} });

    host.broadcast({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'c1' } });
    await waitFor(() => values.length === 1);
    assert.deepEqual(values[0], { type: 'ready', clientId: 'c1' });
  } finally {
    mux.close();
    await host.close();
  }
});

test('error and end frames reach their handlers', async () => {
  const host = await stubMux();
  const mux = new DshRemoteMux(host.url);
  const errors = [];
  let ended = 0;
  try {
    mux.connect();
    await mux.whenOpen();
    mux.open('session/follow', { request: { address: { kind: 'session', sessionId: 's1' } } }, {
      onError: (error) => errors.push(error),
      onEnd: () => {
        ended += 1;
      },
    });
    await waitFor(() => host.received.length === 1);
    const { streamId } = host.received[0];
    assert.deepEqual(host.received[0].payload, {
      args: { request: { address: { kind: 'session', sessionId: 's1' } } },
    });

    host.broadcast({ type: 'error', streamId, error: { code: 'session/agent-busy', message: 'busy', details: {} } });
    await waitFor(() => errors.length === 1);
    assert.match(errors[0].message, /busy/);

    host.broadcast({ type: 'end', streamId });
    await waitFor(() => ended === 1);
  } finally {
    mux.close();
    await host.close();
  }
});

test('frames for unknown streams are ignored', async () => {
  const host = await stubMux();
  const mux = new DshRemoteMux(host.url);
  const values = [];
  try {
    mux.connect();
    await mux.whenOpen();
    mux.open('$events', {}, { onValue: (value) => values.push(value) });
    await waitFor(() => host.received.length === 1);

    host.broadcast({ type: 'item', streamId: 'someone-elses-stream', value: { type: 'emit' } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(values.length, 0);
  } finally {
    mux.close();
    await host.close();
  }
});

test('cancel sends the cancel frame and stops delivery', async () => {
  const host = await stubMux();
  const mux = new DshRemoteMux(host.url);
  const values = [];
  try {
    mux.connect();
    await mux.whenOpen();
    const stream = mux.open('$events', {}, { onValue: (value) => values.push(value) });
    await waitFor(() => host.received.length === 1);
    const { streamId } = host.received[0];

    stream.cancel();
    await waitFor(() => host.received.length === 2);
    assert.deepEqual(host.received[1], { type: 'cancel', streamId });

    host.broadcast({ type: 'item', streamId, value: { type: 'emit' } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(values.length, 0);
  } finally {
    mux.close();
    await host.close();
  }
});

test('close() ends registered streams', async () => {
  const host = await stubMux();
  const mux = new DshRemoteMux(host.url);
  let ended = 0;
  try {
    mux.connect();
    await mux.whenOpen();
    mux.open('$events', {}, { onEnd: () => { ended += 1; } });
    await waitFor(() => host.received.length === 1);
    mux.close();
    assert.equal(ended, 1);
  } finally {
    await host.close();
  }
});

test('handshake headers ride the upgrade request', async () => {
  const seen = [];
  const sockets = new Set();
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    seen.push(req.headers);
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const mux = new DshRemoteMux(`ws://127.0.0.1:${server.address().port}/api/remote.mux`, {
    headers: { cookie: 'dsh-auth-abc=v1.x.y' },
  });
  try {
    mux.connect();
    await mux.whenOpen();
    assert.equal(seen[0].cookie, 'dsh-auth-abc=v1.x.y');
  } finally {
    mux.close();
    // An upgraded socket is not closed by server.close(); drop it explicitly.
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an unauthorized upgrade surfaces 401 instead of a silent close', async () => {
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\nunauthorized');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/api/remote.mux`;
  try {
    const failure = await new Promise((resolve, reject) => {
      const raw = new DshWebSocket();
      raw.on('error', resolve);
      raw.on('close', () => reject(new Error('closed without reporting the status')));
      raw.connect(url);
    });
    // A host that rejects the upgrade writes the status before the handshake,
    // so the message must name it rather than looking like a dropped socket.
    assert.match(failure.message, /HTTP 401/);
    assert.match(failure.message, /browser-session authentication/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
