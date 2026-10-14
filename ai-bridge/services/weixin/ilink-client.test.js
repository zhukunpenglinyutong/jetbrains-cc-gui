import test from 'node:test';
import assert from 'node:assert/strict';

import { IlinkClient, IlinkClientError } from './ilink-client.js';
import { ILINK_DEFAULT_API_BASE_URL, ILINK_PATHS } from './ilink-contract.js';

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
}

function client(fetchImpl, options = {}) {
  return new IlinkClient({
    enabled: true,
    channelVersion: '2.4.9',
    wechatUinFactory: () => 123456789,
    fetchImpl,
    ...options,
  });
}

test('client is disabled by default and makes no network request', async () => {
  let calls = 0;
  const instance = new IlinkClient({ fetchImpl: async () => { calls += 1; } });
  await assert.rejects(instance.getQrCode(), { code: 'ILINK_TRANSPORT_DISABLED' });
  await assert.rejects(instance.sendText(), { code: 'ILINK_TRANSPORT_DISABLED' });
  assert.equal(instance.requestJson, undefined);
  assert.equal(calls, 0);
});

test('QR challenge sends no bearer token and refuses redirects', async () => {
  const calls = [];
  const instance = client(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ qrcode: 'fixture-qr', qrcode_img_content: 'fixture-image' });
  });
  const qr = await instance.getQrCode();
  assert.deepEqual(qr, { qrcode: 'fixture-qr', qrcodeImageContent: 'fixture-image' });
  assert.equal(calls[0].url, `${ILINK_DEFAULT_API_BASE_URL}${ILINK_PATHS.getQrCode}?bot_type=3`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.headers['X-WECHAT-UIN'], Buffer.from('123456789').toString('base64'));
  assert.deepEqual(JSON.parse(calls[0].options.body), { local_token_list: [] });
});

test('QR challenge accepts JSON bodies when the server mislabels the content type', async () => {
  const instance = client(async () => new Response(JSON.stringify({
    qrcode: 'fixture-qr', qrcode_img_content: 'fixture-image',
  }), { headers: { 'content-type': 'text/plain; charset=utf-8' } }));

  assert.deepEqual(await instance.getQrCode(), {
    qrcode: 'fixture-qr', qrcodeImageContent: 'fixture-image',
  });

  const html = client(async () => new Response('<html>gateway error</html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  await assert.rejects(html.getQrCode(), { code: 'ILINK_RESPONSE_CONTENT_TYPE_INVALID' });
});

test('QR challenge renders the official login URL as a PNG data URL', async () => {
  const loginUrl = 'https://liteapp.weixin.qq.com/q/fixture?ticket=secret';
  const instance = client(async () => jsonResponse({
    qrcode: 'fixture-qr', qrcode_img_content: loginUrl,
  }));

  const qr = await instance.getQrCode();
  assert.equal(qr.qrcode, 'fixture-qr');
  assert.match(qr.qrcodeImageContent, /^data:image\/png;base64,/);
  assert.ok(qr.qrcodeImageContent.length < 32 * 1024);
  assert.equal(Buffer.from(qr.qrcodeImageContent.split(',')[1], 'base64').subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a');
});

test('QR challenge rejects external login URLs', async () => {
  const instance = client(async () => jsonResponse({
    qrcode: 'fixture-qr', qrcode_img_content: 'https://example.com/qr',
  }));
  await assert.rejects(instance.getQrCode(), { code: 'ILINK_PAIRING_QR_INVALID' });
});

test('QR polling follows only approved redirects and does not forward bearer credentials', async () => {
  const calls = [];
  const instance = client(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ status: 'scaned_but_redirect', redirect_host: 'route-1.weixin.qq.com' });
  });
  const redirect = await instance.getQrCodeStatus({ qrcode: 'fixture-qr' });
  assert.equal(redirect.redirectHost, 'https://route-1.weixin.qq.com');
  assert.equal(new URL(calls[0].url).searchParams.get('qrcode'), 'fixture-qr');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.headers['X-WECHAT-UIN'], undefined);

  const redirected = client(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ status: 'wait' });
  });
  await redirected.getQrCodeStatus({ baseUrl: redirect.redirectHost, qrcode: 'fixture-qr' });
  assert.equal(new URL(calls[1].url).origin, redirect.redirectHost);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers['X-WECHAT-UIN'], undefined);

  const malicious = client(async () => jsonResponse({
    status: 'scaned_but_redirect', redirect_host: 'attacker.example',
  }));
  await assert.rejects(malicious.getQrCodeStatus({ qrcode: 'fixture-qr' }));
});

test('getUpdates uses the stored cursor and rejects business errors', async () => {
  const calls = [];
  const instance = client(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ ret: 0, msgs: [], get_updates_buf: 'next-cursor' });
  });
  const result = await instance.getUpdates({ botToken: 'fixture-token', cursor: 'old-cursor' });
  assert.equal(result.cursor, 'next-cursor');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.parse(calls[0].options.body).get_updates_buf, 'old-cursor');

  const rejected = client(async () => jsonResponse({ ret: -14, msgs: [] }));
  await assert.rejects(rejected.getUpdates({ botToken: 'fixture-token' }), {
    code: 'ILINK_AUTH_REJECTED',
  });
});

test('getUpdates accepts a successful response that omits ret', async () => {
  const instance = client(async () => jsonResponse({ msgs: [], get_updates_buf: 'next-cursor' }));

  const result = await instance.getUpdates({ botToken: 'fixture-token', cursor: 'old-cursor' });

  assert.equal(result.ok, true);
  assert.equal(result.cursor, 'next-cursor');
});

test('getUpdates preserves distinct uint64 identifiers without altering message text', async () => {
  const text = 'Example: "message_id": 18446744073709551615, with \\slashes and "quotes"';
  const wireMessage = (identifier) => `{"message_id":${identifier},"from_user_id":"user-1",`
    + `"context_token":"context-1","item_list":[{"type":1,"text_item":{"text":${JSON.stringify(text)}}}]}`;
  const payload = `{"msgs":[${wireMessage('9007199254740992')},${wireMessage('9007199254740993')},`
    + `${wireMessage('18446744073709551615')}],"get_updates_buf":"next"}`;
  const instance = client(async () => new Response(payload));

  const result = await instance.getUpdates({ botToken: 'fixture-token' });

  assert.deepEqual(result.messages.map((message) => message.messageId), [
    '9007199254740992', '9007199254740993', '18446744073709551615',
  ]);
  assert.ok(result.messages.every((message) => message.text === text));
  assert.equal(result.receivedCount, 3);
  assert.equal(result.droppedCount, 0);
});

test('getUpdates preserves escaped property names and rejects fractional message identifiers', async () => {
  const payload = '{"msgs":[{"message_\\u0069d":18446744073709551615,"from_user_id":"user-1",'
    + '"context_token":"ctx","item_list":[{"type":1,"text_item":{"text":"hello"}}]},'
    + '{"message_id":1.5,"from_user_id":"user-1","context_token":"ctx",'
    + '"item_list":[{"type":1,"text_item":{"text":"hello"}}]}]}';
  const instance = client(async () => new Response(payload));

  const result = await instance.getUpdates({ botToken: 'fixture-token' });

  assert.equal(result.messages[0].messageId, '18446744073709551615');
  assert.equal(result.messages.length, 1);
  assert.equal(result.receivedCount, 2);
  assert.equal(result.droppedCount, 1);
});

test('authenticated requests generate a fresh WeChat client identifier per request', async () => {
  const headers = [];
  let nextUin = 100;
  const instance = client(async (url, options) => {
    headers.push(options.headers['X-WECHAT-UIN']);
    return jsonResponse({ ret: 0, msgs: [], get_updates_buf: 'next' });
  }, { wechatUinFactory: () => nextUin++ });
  await instance.getUpdates({ botToken: 'fixture-token' });
  await instance.getUpdates({ botToken: 'fixture-token' });
  assert.notEqual(headers[0], headers[1]);
  assert.equal(headers[0], Buffer.from('100').toString('base64'));
  assert.equal(headers[1], Buffer.from('101').toString('base64'));
});

test('getUpdates preserves safe server rejection diagnostics', async () => {
  const instance = client(async () => jsonResponse({
    ret: 1201,
    errcode: 3007,
    errmsg: 'invalid bot token',
  }));
  await assert.rejects(instance.getUpdates({ botToken: 'fixture-token' }), (error) => {
    assert.equal(error.code, 'ILINK_GET_UPDATES_REJECTED');
    assert.equal(error.ret, 1201);
    assert.equal(error.errorCode, 3007);
    assert.equal(error.errorMessage, 'invalid bot token');
    return true;
  });
});

test('getUpdates treats ret -14 as an authentication rejection', async () => {
  const instance = client(async () => jsonResponse({ ret: -14, errmsg: 'session timeout' }));

  await assert.rejects(instance.getUpdates({ botToken: 'fixture-token', cursor: 'saved-cursor' }), {
    code: 'ILINK_AUTH_REJECTED',
    ret: -14,
  });
});

test('getUpdates uses the long-poll timeout independently of regular API requests', async () => {
  const instance = client(async (url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(options.signal.aborted, false);
    return jsonResponse({ ret: 0, msgs: [] });
  }, { timeoutMs: 5, getUpdatesTimeoutMs: 250 });

  const result = await instance.getUpdates({ botToken: 'fixture-token' });
  assert.equal(result.ok, true);
  assert.throws(() => new IlinkClient({ getUpdatesTimeoutMs: 0 }), RangeError);
});

test('getUpdates treats its own timeout as an empty response but preserves caller cancellation', async () => {
  const timedOut = client((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('long poll timed out')), { once: true });
  }), { getUpdatesTimeoutMs: 10 });
  const timeoutResult = await timedOut.getUpdates({ botToken: 'fixture-token', cursor: 'saved-cursor' });
  assert.deepEqual(timeoutResult.messages, []);
  assert.equal(timeoutResult.cursor, 'saved-cursor');

  const controller = new AbortController();
  controller.abort();
  const cancelled = client((url, { signal }) => {
    assert.equal(signal.aborted, true);
    return Promise.reject(new Error('cancelled'));
  });
  await assert.rejects(cancelled.getUpdates({
    botToken: 'fixture-token', cursor: 'saved-cursor', signal: controller.signal,
  }), { code: 'ILINK_REQUEST_ABORTED' });
});

test('sendText accepts explicit success and rejects business errors without retries', async () => {
  let calls = 0;
  const instance = client(async (url, options) => {
    calls += 1;
    assert.equal(url, `${ILINK_DEFAULT_API_BASE_URL}${ILINK_PATHS.sendMessage}`);
    const body = JSON.parse(options.body);
    assert.equal(body.msg.context_token, 'fixture-context');
    assert.equal(body.msg.client_id, 'fixture-client-id');
    return jsonResponse({ ret: 0, errmsg: '' });
  });
  const response = await instance.sendText({
    botToken: 'fixture-token',
    toUserId: 'fixture-user',
    clientId: 'fixture-client-id',
    text: 'fixture text',
    contextToken: 'fixture-context',
  });
  assert.equal(response.ok, true);
  assert.equal(calls, 1);

  const failed = client(async () => jsonResponse({ ret: 1, errcode: 403, errmsg: 'forbidden' }));
  await assert.rejects(failed.sendText({
    botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
  }), (error) => {
    assert.equal(error.code, 'ILINK_SEND_REJECTED');
    assert.equal(error.ret, 1);
    assert.equal(error.errorCode, 403);
    assert.equal(error.errorMessage, 'forbidden');
    return true;
  });
});

test('sendText retries explicit rate limits with exponential backoff', async () => {
  let calls = 0;
  const instance = client(async () => {
    calls += 1;
    return calls < 3 ? jsonResponse({ ret: 1, errcode: 429, errmsg: 'too many requests' })
      : jsonResponse({ ret: 0 });
  }, { rateLimitBackoffBaseMs: 1 });

  const result = await instance.sendText({
    botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test('sendText does not retry parameter errors reported as ret -2', async () => {
  let calls = 0;
  const instance = client(async () => {
    calls += 1;
    return jsonResponse({ ret: -2, errcode: -2, errmsg: 'parameter error' });
  }, { rateLimitBackoffBaseMs: 1 });

  await assert.rejects(instance.sendText({
    botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
  }), { code: 'ILINK_SEND_REJECTED', ret: -2, errorCode: -2 });
  assert.equal(calls, 1);
});

test('sendText retries HTTP 429 and preserves the status after exhaustion', async () => {
  let calls = 0;
  const instance = client(async () => {
    calls += 1;
    return jsonResponse({ error: 'busy' }, { status: 429 });
  }, { rateLimitBackoffBaseMs: 1, sendRetries: 2 });

  await assert.rejects(instance.sendText({
    botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
  }), { code: 'ILINK_SEND_RATE_LIMITED', httpStatus: 429 });
  assert.equal(calls, 3);
});

test('sendText reports explicit rate limits and bounded retry-after without internal retry when disabled', async () => {
  let calls = 0;
  const instance = client(async () => {
    calls += 1;
    return jsonResponse({}, { status: 429, headers: { 'retry-after': '600' } });
  }, { sendRetries: 0 });
  await assert.rejects(instance.sendText({
    botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
  }), { code: 'ILINK_SEND_RATE_LIMITED', httpStatus: 429, retryAfterMs: 600_000 });
  assert.equal(calls, 1);
});

test('bare ret -2 does not imply rate limiting but an explicit rate-limited message does', async () => {
  for (const [errmsg, code] of [['prepare failed', 'ILINK_SEND_REJECTED'], ['unknown error', 'ILINK_SEND_REJECTED'],
    ['rate limited', 'ILINK_SEND_RATE_LIMITED']]) {
    const instance = client(async () => jsonResponse({ ret: -2, errmsg }), { sendRetries: 0 });
    await assert.rejects(instance.sendText({
      botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
    }), { code, ret: -2 });
  }
});

test('sendText accepts successful responses with omitted zero-valued status fields', async () => {
  for (const payload of [{}, { message_id: '18446744073709551615' }, { errcode: 0 }, { errmsg: '' }]) {
    let calls = 0;
    const instance = client(async () => {
      calls += 1;
      return jsonResponse(payload);
    });

    const result = await instance.sendText({
      botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 1);
  }
});

test('sendText rejects an error code even when ret is omitted or zero', async () => {
  for (const payload of [{ errcode: -14 }, { ret: 0, errcode: 403 }, { ret: 1, errcode: 0 }]) {
    let calls = 0;
    const instance = client(async () => {
      calls += 1;
      return jsonResponse(payload);
    });

    await assert.rejects(instance.sendText({
      botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
    }), { code: 'ILINK_SEND_REJECTED' });
    assert.equal(calls, 1);
  }
});

test('sendText treats malformed response shapes and status fields as unknown without retries', async () => {
  for (const payload of [null, [], 'ok', { ret: '0' }, { errcode: '0' }]) {
    let calls = 0;
    const instance = client(async () => {
      calls += 1;
      return jsonResponse(payload);
    });

    await assert.rejects(instance.sendText({
      botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
    }), { code: 'ILINK_SEND_RESULT_UNKNOWN' });
    assert.equal(calls, 1);
  }
});

test('sendText classifies timeouts, HTTP failures, and invalid responses as unknown', async () => {
  const send = (fetchImpl, options = {}) => client(fetchImpl, options).sendText({
    botToken: 'fixture-token', toUserId: 'fixture-user', clientId: 'id', text: 'x', contextToken: 'ctx',
  });
  await assert.rejects(send(async () => { throw new Error('socket reset'); }), {
    code: 'ILINK_SEND_RESULT_UNKNOWN',
  });
  await assert.rejects(send(async () => jsonResponse({}, { status: 503 })), {
    code: 'ILINK_SEND_RESULT_UNKNOWN', httpStatus: 503,
  });
  await assert.rejects(send(async () => new Response('not-json', {
    headers: { 'content-type': 'application/json' },
  })), { code: 'ILINK_SEND_RESULT_UNKNOWN' });
  await assert.rejects(send(async () => new Response('')), { code: 'ILINK_SEND_RESULT_UNKNOWN' });
  await assert.rejects(send(async () => jsonResponse({ payload: 'too-large' }), {
    maxResponseBytes: 8,
  }), { code: 'ILINK_SEND_RESULT_UNKNOWN' });

  const timed = send((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), { timeoutMs: 10 });
  await assert.rejects(timed, { code: 'ILINK_SEND_RESULT_UNKNOWN' });
});

test('response reading enforces the configured byte cap', async () => {
  const instance = client(async () => jsonResponse({ payload: 'long-value' }), { maxResponseBytes: 8 });
  await assert.rejects(instance.getQrCode(), { code: 'ILINK_RESPONSE_TOO_LARGE' });
});

test('request failures expose stable codes without echoing credentials', async () => {
  const token = 'do-not-include-this-token';
  const instance = client(async () => { throw new Error(`failed with ${token}`); });
  await assert.rejects(instance.getUpdates({ botToken: token }), (error) => {
    assert.ok(error instanceof IlinkClientError);
    assert.equal(error.code, 'ILINK_REQUEST_FAILED');
    assert.equal(error.message.includes(token), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});
