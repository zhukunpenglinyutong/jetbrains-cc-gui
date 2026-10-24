import test from 'node:test';
import assert from 'node:assert/strict';

import { IlinkPairingError, IlinkPairingSession } from './ilink-pairing.js';

function fakeClient(statuses, options = {}) {
  const calls = [];
  let qrSequence = 0;
  return {
    calls,
    client: {
      async getQrCode(request) {
        calls.push({ type: 'qr', request });
        qrSequence += 1;
        return {
          qrcode: `qr-${qrSequence}`,
          qrcodeImageContent: `image-${qrSequence}`,
        };
      },
      async getQrCodeStatus(request) {
        calls.push({ type: 'status', request });
        const next = statuses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      ...options,
    },
  };
}

test('starts pairing without exposing the raw QR challenge', async () => {
  const fixture = fakeClient([]);
  const session = new IlinkPairingSession({ client: fixture.client });
  const snapshot = await session.start({ localTokenList: ['old-token'] });

  assert.deepEqual(snapshot, {
    state: 'WAITING_SCAN',
    refreshCount: 0,
    qrCodeImageContent: 'image-1',
  });
  assert.equal(snapshot.qrcode, undefined);
  assert.equal(fixture.calls[0].type, 'qr');
  assert.deepEqual(fixture.calls[0].request.localTokenList, ['old-token']);
  assert.ok(fixture.calls[0].request.signal instanceof AbortSignal);
});

test('handles verification and approved IDC redirect before confirmation', async () => {
  const fixture = fakeClient([
    { status: 'need_verifycode' },
    { status: 'scaned' },
    { status: 'scaned_but_redirect', redirectHost: 'https://route-1.weixin.qq.com' },
    { status: 'wait' },
    {
      status: 'confirmed',
      botToken: 'fixture-token',
      botId: 'fixture-bot',
      baseUrl: 'https://route-1.weixin.qq.com',
      userId: 'fixture-user',
    },
  ]);
  const session = new IlinkPairingSession({ client: fixture.client });
  await session.start();

  assert.equal((await session.poll()).state, 'NEED_VERIFY_CODE');
  assert.equal((await session.poll({ verifyCode: '123 456' })).state, 'SCANNED');
  assert.equal((await session.poll()).pollingBaseUrl, 'https://route-1.weixin.qq.com');
  assert.equal((await session.poll()).state, 'WAITING_SCAN');
  const bound = await session.poll();

  assert.deepEqual(bound, {
    state: 'BOUND',
    refreshCount: 0,
    credentials: {
      botToken: 'fixture-token',
      botId: 'fixture-bot',
      baseUrl: 'https://route-1.weixin.qq.com',
      userId: 'fixture-user',
    },
  });
  assert.equal(fixture.calls[5].request.baseUrl, 'https://route-1.weixin.qq.com');
  assert.equal(fixture.calls[5].request.qrcode, 'qr-1');
});

test('refreshes expired QR codes and stops at the configured limit', async () => {
  const fixture = fakeClient([
    { status: 'expired' },
    { status: 'expired' },
    { status: 'wait' },
  ]);
  const session = new IlinkPairingSession({ client: fixture.client, maxQrRefreshes: 1 });
  await session.start();

  assert.equal((await session.poll()).state, 'WAITING_SCAN');
  assert.equal(session.snapshot().refreshCount, 1);
  assert.equal((await session.poll()).state, 'EXPIRED');
  assert.equal(fixture.calls.filter((call) => call.type === 'qr').length, 2);
  await assert.rejects(session.poll(), { code: 'ILINK_PAIRING_TERMINAL' });
});

test('revalidates redirect and base URL values supplied by a client implementation', async () => {
  const redirectFixture = fakeClient([{ status: 'scaned_but_redirect', redirectHost: 'attacker.example' }]);
  const redirectSession = new IlinkPairingSession({ client: redirectFixture.client });
  await redirectSession.start();
  await assert.rejects(redirectSession.poll(), { code: 'ILINK_PAIRING_REDIRECT_INVALID' });

  const baseFixture = fakeClient([{
    status: 'confirmed', botToken: 'fixture-token', botId: 'fixture-bot', baseUrl: 'https://attacker.example',
  }]);
  const baseSession = new IlinkPairingSession({ client: baseFixture.client });
  await baseSession.start();
  await assert.rejects(baseSession.poll(), { code: 'ILINK_PAIRING_CONFIRMATION_INVALID' });
});

test('treats an already bound account as terminal without returning credentials', async () => {
  const fixture = fakeClient([{ status: 'binded_redirect' }]);
  const session = new IlinkPairingSession({ client: fixture.client });
  await session.start();

  assert.deepEqual(await session.poll(), { state: 'ALREADY_BOUND', refreshCount: 0 });
});

test('preserves cancellation and timeout as local terminal states', async () => {
  let now = 100;
  const fixture = fakeClient([{ status: 'wait' }]);
  const session = new IlinkPairingSession({
    client: fixture.client,
    clock: () => now,
    maxDurationMs: 50,
  });
  await session.start();
  now = 151;
  assert.deepEqual(await session.poll(), { state: 'TIMEOUT', refreshCount: 0 });

  const cancelled = new IlinkPairingSession({ client: fakeClient([]).client });
  assert.deepEqual(cancelled.cancel(), { state: 'CANCELLED', refreshCount: 0 });
  await assert.rejects(cancelled.poll(), { code: 'ILINK_PAIRING_TERMINAL' });
});

test('aborts an in-flight status request when the overall pairing deadline expires', async () => {
  let now = 100;
  const fixture = fakeClient([]);
  fixture.client.getQrCodeStatus = async ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const session = new IlinkPairingSession({
    client: fixture.client,
    clock: () => now,
    maxDurationMs: 20,
  });
  await session.start();
  assert.deepEqual(await session.poll(), { state: 'TIMEOUT', refreshCount: 0 });
});

test('rejects invalid lifecycle and confirmation states without leaking values', async () => {
  const fixture = fakeClient([{ status: 'confirmed', botToken: '', botId: 'id' }]);
  const session = new IlinkPairingSession({ client: fixture.client });
  await assert.rejects(session.poll(), { code: 'ILINK_PAIRING_NOT_STARTED' });
  await session.start();
  await assert.rejects(session.poll(), (error) => {
    assert.ok(error instanceof IlinkPairingError);
    assert.equal(error.code, 'ILINK_PAIRING_CONFIRMATION_INVALID');
    assert.equal(error.message.includes('id'), false);
    return true;
  });
});
