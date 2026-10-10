import test from 'node:test';
import assert from 'node:assert/strict';

import { IlinkRuntime, publicErrorDetails } from './ilink-runtime.js';
import { IlinkClient, IlinkClientError } from './ilink-client.js';

function createPairingClient() {
  return {
    async getQrCode() {
      return { qrcode: 'secret-qr', qrcodeImageContent: 'data:image/png;base64,AAAA' };
    },
    async getQrCodeStatus() {
      return {
        status: 'confirmed',
        botToken: 'secret-token',
        botId: 'bot-1',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        userId: 'user-1',
      };
    },
  };
}

test('runtime returns sanitized pairing state and consumes credentials once', async () => {
  const runtime = new IlinkRuntime({
    clientFactory: () => createPairingClient(),
    clock: () => 1000,
  });

  const started = await runtime.startPairing();
  assert.equal(started.state, 'WAITING_SCAN');
  assert.equal(started.qrCodeImageContent, 'data:image/png;base64,AAAA');
  assert.equal(started.expiresAt, 301000);
  assert.equal('qrcode' in started, false);

  const confirmed = await runtime.pollPairing();
  assert.equal(confirmed.state, 'BOUND');
  assert.equal(confirmed.credentials.botId, 'bot-1');
  assert.equal(confirmed.credentials.botToken, 'secret-token');
  assert.equal(runtime.status().pairingState, 'IDLE');
});

test('runtime delivers numeric wire messages and reports filtered messages through the bridge', async () => {
  const runtime = new IlinkRuntime({
    clientFactory: (options) => new IlinkClient({
      ...options,
      enabled: true,
      fetchImpl: async () => new Response('{"msgs":[{"message_id":18446744073709551615,'
        + '"from_user_id":"user-1","context_token":"ctx",'
        + '"item_list":[{"type":1,"text_item":{"text":"/sessions"}}]},null],"get_updates_buf":"next"}'),
    }),
  });
  runtime.startTransport({ baseUrl: 'https://ilinkai.weixin.qq.com', botToken: 'secret-token' });

  const result = JSON.parse(JSON.stringify(await runtime.getUpdates()));

  assert.deepEqual(result, {
    messages: [{ messageId: '18446744073709551615', fromUserId: 'user-1', contextToken: 'ctx', text: '/sessions' }],
    cursor: 'next',
    receivedCount: 2,
    droppedCount: 1,
  });
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

test('public error details omit untrusted server text', () => {
  const error = new IlinkClientError('ILINK_GET_UPDATES_REJECTED', {
    ret: 1201,
    errorCode: 3007,
    errorMessage: 'invalid token secret-token-value-1234567890',
  });

  assert.equal(publicErrorDetails(error), 'ret=1201;errcode=3007');
});

test('runtime wraps raw QR image base64 using its detected image format', async () => {
  const client = createPairingClient();
  client.getQrCode = async () => ({
    qrcode: 'secret-qr',
    qrcodeImageContent: 'iVBORw0KGgo=',
  });
  const runtime = new IlinkRuntime({ clientFactory: () => client, clock: () => 1000 });

  const started = await runtime.startPairing();

  assert.equal(started.qrCodeImageContent, 'data:image/png;base64,iVBORw0KGgo=');
});

test('runtime rejects unknown QR image formats and SVG data URLs', async () => {
  for (const image of ['not-an-image', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    const client = createPairingClient();
    client.getQrCode = async () => ({ qrcode: 'secret-qr', qrcodeImageContent: image });
    const runtime = new IlinkRuntime({ clientFactory: () => client, clock: () => 1000 });

    await assert.rejects(runtime.startPairing(), { code: 'ILINK_PAIRING_QR_INVALID' });
  }
});

test('runtime never exposes transport token through status', () => {
  const runtime = new IlinkRuntime({
    clientFactory: () => ({ getUpdates: async () => ({ messages: [], cursor: 'next' }) }),
  });
  runtime.startTransport({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    botToken: 'secret-token',
  });
  assert.deepEqual(runtime.status(), {
    pairingState: 'IDLE',
    pairingExpiresAt: null,
    pairingAttempt: 0,
    transportState: 'READY',
  });
});

test('runtime accepts sendText without optional metadata', async () => {
  let request;
  const runtime = new IlinkRuntime({
    clientFactory: () => ({
      sendText: async (values) => {
        request = values;
        return { ret: 0, ok: true };
      },
    }),
  });
  runtime.startTransport({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    botToken: 'secret-token',
  });

  const result = await runtime.sendText({
    toUserId: 'user-1',
    clientId: 'client-1',
    text: 'hello',
    contextToken: 'context-1',
  });

  assert.equal(result.ok, true);
  assert.equal(request.fromUserId, '');
  assert.equal(request.runId, '');
});

test('runtime returns a successful bridge response when a send acknowledgement omits ret', async () => {
  let calls = 0;
  const runtime = new IlinkRuntime({
    clientFactory: (options) => new IlinkClient({
      ...options,
      enabled: true,
      fetchImpl: async () => {
        calls += 1;
        return new Response('{"message_id":18446744073709551615}');
      },
    }),
  });
  runtime.startTransport({ baseUrl: 'https://ilinkai.weixin.qq.com', botToken: 'secret-token' });

  const result = JSON.parse(JSON.stringify(await runtime.sendText({
    toUserId: 'user-1', clientId: 'client-1', text: 'hello', contextToken: 'context-1',
  })));

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
  assert.equal(runtime.status().transportState, 'READY');
});

test('runtime preserves the last cursor when a successful response omits one', async () => {
  const cursors = [];
  const runtime = new IlinkRuntime({
    clientFactory: () => ({
      getUpdates: async ({ cursor }) => {
        cursors.push(cursor);
        return { messages: [], cursor: undefined };
      },
    }),
  });
  runtime.startTransport({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    botToken: 'secret-token',
    cursor: 'initial-cursor',
  });

  assert.equal((await runtime.getUpdates()).cursor, 'initial-cursor');
  assert.equal((await runtime.getUpdates()).cursor, 'initial-cursor');
  assert.deepEqual(cursors, ['initial-cursor', 'initial-cursor']);
});

test('runtime rejects an untrusted iLink endpoint before creating a client', async () => {
  const runtime = new IlinkRuntime({ clientFactory: () => createPairingClient() });
  await assert.rejects(
    runtime.startPairing({ baseUrl: 'https://example.com' }),
    /iLink base URL is not an approved host/,
  );
});
