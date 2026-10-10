import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ILINK_DEFAULT_API_BASE_URL,
  ILINK_PATHS,
  ILINK_REFERENCE_VERSION,
  buildIlinkUrl,
  buildQrCodeRequest,
  buildQrCodeStatusRequest,
  buildGetUpdatesRequest,
  buildSendTextMessageRequest,
  encodeIlinkClientVersion,
  normalizeIlinkBaseUrl,
  parseBusinessResponse,
  parseGetUpdatesResponse,
  parseQrCodeResponse,
  parseQrCodeStatusResponse,
  redactIlinkHeaders,
  redactIlinkUrl,
} from './ilink-contract.js';

const channelVersion = '2.4.9';
const wechatUin = 123456789;
const botToken = 'test-token-not-a-real-credential';

test('normalizes approved HTTPS hosts in the Weixin API domain', () => {
  assert.equal(normalizeIlinkBaseUrl(), ILINK_DEFAULT_API_BASE_URL);
  assert.equal(normalizeIlinkBaseUrl('https://ilinkai.weixin.qq.com/'), ILINK_DEFAULT_API_BASE_URL);
  assert.equal(normalizeIlinkBaseUrl('https://route-1.weixin.qq.com'), 'https://route-1.weixin.qq.com');
  for (const candidate of [
    'http://ilinkai.weixin.qq.com',
    'https://ilinkai.weixin.qq.com.evil.example',
    'https://weixin.qq.com.evil.example',
    'https://user:pass@ilinkai.weixin.qq.com',
    'https://127.0.0.1',
    'https://route-1.weixin.qq.com:444',
    'https://ilinkai.weixin.qq.com/other',
    'https://ilinkai.weixin.qq.com/?token=secret',
  ]) {
    assert.throws(() => normalizeIlinkBaseUrl(candidate));
  }
  assert.throws(() => buildIlinkUrl(undefined, '/not-an-ilink-api'));
});

test('encodes application version as a 24-bit decimal version', () => {
  assert.equal(ILINK_REFERENCE_VERSION, channelVersion);
  assert.equal(encodeIlinkClientVersion('2.4.9'), String(0x020409));
  assert.equal(encodeIlinkClientVersion('v2.4.9'), String(0x020409));
  assert.throws(() => encodeIlinkClientVersion('256.4.9'));
  assert.throws(() => encodeIlinkClientVersion('latest'));
});

test('builds QR challenge without bearer credentials', () => {
  const request = buildQrCodeRequest({ channelVersion, wechatUin });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `${ILINK_DEFAULT_API_BASE_URL}${ILINK_PATHS.getQrCode}?bot_type=3`);
  assert.deepEqual(request.body, { local_token_list: [] });
  assert.equal(request.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.headers['iLink-App-ClientVersion'], String(0x020409));
  assert.equal(request.headers['X-WECHAT-UIN'], Buffer.from(String(wechatUin)).toString('base64'));
  assert.throws(() => buildQrCodeRequest({ channelVersion }));
  assert.throws(() => buildQrCodeRequest({ channelVersion, wechatUin, routeTag: 'bad\r\nheader' }));
});

test('QR status request encodes challenge and does not send authentication headers', () => {
  const request = buildQrCodeStatusRequest({
    channelVersion,
    qrcode: 'not a real QR?&code',
    verifyCode: '123 456',
  });
  assert.equal(request.method, 'GET');
  assert.equal(new URL(request.url).searchParams.get('qrcode'), 'not a real QR?&code');
  assert.equal(new URL(request.url).searchParams.get('verify_code'), '123 456');
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.headers.AuthorizationType, undefined);
  assert.equal(request.headers['X-WECHAT-UIN'], undefined);
  assert.equal(redactIlinkUrl(request.url).includes('not a real QR'), false);
  assert.equal(redactIlinkUrl(request.url).includes('123+456'), false);
  assert.throws(() => buildQrCodeStatusRequest({ qrcode: 'fixture', verifyCode: 'bad\ncode' }));
});

test('parses QR states and refuses incomplete confirmation', () => {
  assert.deepEqual(parseQrCodeResponse({ qrcode: 'fixture', qrcode_img_content: 'fixture-image' }), {
    qrcode: 'fixture',
    qrcodeImageContent: 'fixture-image',
  });
  assert.deepEqual(parseQrCodeStatusResponse({
    status: 'scaned_but_redirect', redirect_host: 'route-1.weixin.qq.com',
  }), {
    status: 'scaned_but_redirect',
    botToken: undefined,
    botId: undefined,
    baseUrl: undefined,
    redirectHost: 'https://route-1.weixin.qq.com',
    userId: undefined,
  });
  assert.equal(parseQrCodeStatusResponse({ status: 'wait', baseurl: '' }).baseUrl, undefined);
  assert.throws(() => parseQrCodeStatusResponse({ status: 'scaned_but_redirect', redirect_host: '127.0.0.1' }));
  assert.throws(() => parseQrCodeStatusResponse({
    status: 'scaned_but_redirect', redirect_host: 'route-1.weixin.qq.com.evil.example',
  }));
  assert.throws(() => parseQrCodeStatusResponse({
    status: 'scaned_but_redirect', redirect_host: 'route-1.weixin.qq.com:443',
  }));
  assert.equal(parseQrCodeStatusResponse({
    status: 'confirmed', bot_token: botToken, ilink_bot_id: 'fixture-bot',
    baseurl: 'https://route-1.weixin.qq.com',
  }).baseUrl, 'https://route-1.weixin.qq.com');
  assert.equal(parseQrCodeStatusResponse({
    status: 'confirmed', bot_token: botToken, ilink_bot_id: 'fixture-bot',
  }).botToken, botToken);
  assert.throws(() => parseQrCodeStatusResponse({ status: 'confirmed', ilink_bot_id: 'fixture-bot' }));
  assert.throws(() => parseQrCodeStatusResponse({ status: 'unknown' }));
});

test('getUpdates carries the cursor and fails closed on business errors', () => {
  const request = buildGetUpdatesRequest({
    channelVersion, wechatUin, botToken, cursor: 'fixture-cursor',
  });
  assert.equal(request.url, `${ILINK_DEFAULT_API_BASE_URL}${ILINK_PATHS.getUpdates}`);
  assert.equal(request.body.get_updates_buf, 'fixture-cursor');
  assert.equal(request.body.base_info.channel_version, channelVersion);
  assert.equal(request.headers.Authorization, `Bearer ${botToken}`);
  assert.throws(() => buildGetUpdatesRequest({
    channelVersion, wechatUin, botToken: 'bad\r\nheader',
  }));
  assert.equal(redactIlinkHeaders(request.headers).Authorization, '[REDACTED]');
  assert.equal(redactIlinkHeaders(request.headers)['X-WECHAT-UIN'], '[REDACTED]');
  assert.deepEqual(parseGetUpdatesResponse({ ret: 0, msgs: [], get_updates_buf: 'next' }), {
    ret: 0,
    errorCode: undefined,
    errorMessage: undefined,
    ok: true,
    messages: [],
    receivedCount: 0,
    droppedCount: 0,
    cursor: 'next',
    longPollingTimeoutMs: undefined,
  });
  assert.equal(parseGetUpdatesResponse({ ret: -14, msgs: [] }).ok, false);
  assert.equal(parseGetUpdatesResponse({ msgs: [] }).ok, true);
  assert.equal(parseGetUpdatesResponse({ ret: 0, msgs: [] }).cursor, undefined);
  assert.throws(() => parseGetUpdatesResponse({ ret: 0, msgs: {} }));
});

test('getUpdates rejects unsupported content without forwarding partial text or media payloads', () => {
  const result = parseGetUpdatesResponse({
    ret: 0,
    msgs: [
      {
        message_id: 'message-1',
        from_user_id: 'user-1',
        context_token: 'context-1',
        item_list: [
          { type: 1, text_item: { text: 'hello' } },
          { type: 1, text_item: { text: 'world' } },
        ],
      },
      {
        message_id: 'mixed-content',
        from_user_id: 'user-1',
        context_token: 'context-2',
        item_list: [
          { type: 1, text_item: { text: 'do not partially forward' } },
          { type: 2, image_item: { media: 'private-media-reference' } },
        ],
      },
      {
        message_id: 'image-only',
        from_user_id: 'user-1',
        context_token: 'context-3',
        item_list: [{ type: 2, image_item: { media: 'private-media-reference' } }],
      },
    ],
  });
  assert.deepEqual(result.messages, [
    { messageId: 'message-1', fromUserId: 'user-1', contextToken: 'context-1', text: 'hello\nworld' },
    {
      messageId: 'mixed-content', fromUserId: 'user-1', contextToken: 'context-2',
      text: '', action: 'UNSUPPORTED_MEDIA',
    },
    {
      messageId: 'image-only', fromUserId: 'user-1', contextToken: 'context-3',
      text: '', action: 'UNSUPPORTED_MEDIA',
    },
  ]);
  assert.equal(result.receivedCount, 3);
  assert.equal(result.droppedCount, 0);
  assert.equal(JSON.stringify(result.messages).includes('private-media-reference'), false);
});

test('numeric message identifiers accept safe integers and reject already rounded values', () => {
  for (const [messageId, accepted] of [[0, true], [42, true], [Number.MAX_SAFE_INTEGER, true],
    [Number.MAX_SAFE_INTEGER + 1, false], [-1, false], [1.5, false], [null, false]]) {
    const result = parseGetUpdatesResponse({ msgs: [{
      message_id: messageId,
      from_user_id: 'user-1',
      context_token: 'context-1',
      item_list: [{ type: 1, text_item: { text: '/sessions' } }],
    }] });
    assert.equal(result.messages.length, accepted ? 1 : 0);
    assert.equal(result.receivedCount, 1);
    assert.equal(result.droppedCount, accepted ? 0 : 1);
    if (accepted) assert.equal(result.messages[0].messageId, String(messageId));
  }
});

test('text send requires an explicit target, context token, and stable client id', () => {
  const request = buildSendTextMessageRequest({
    channelVersion,
    wechatUin,
    botToken,
    toUserId: 'fixture-user',
    clientId: 'fixture-client-id',
    text: 'hello',
    contextToken: 'fixture-context',
  });
  assert.equal(request.url, `${ILINK_DEFAULT_API_BASE_URL}${ILINK_PATHS.sendMessage}`);
  assert.equal(request.body.msg.to_user_id, 'fixture-user');
  assert.equal(request.body.msg.context_token, 'fixture-context');
  assert.equal(request.body.msg.client_id, 'fixture-client-id');
  assert.deepEqual(request.body.msg.item_list, [{ type: 1, text_item: { text: 'hello' } }]);
  assert.throws(() => buildSendTextMessageRequest({
    channelVersion, wechatUin, botToken, toUserId: 'fixture-user', clientId: 'fixture-client-id', text: 'hello',
  }));
});

test('business response accepts omitted zero-valued status fields and rejects explicit errors', () => {
  assert.deepEqual(parseBusinessResponse({ ret: 0, errmsg: '' }), {
    ret: 0, errorCode: undefined, errorMessage: '', ok: true,
  });
  assert.equal(parseBusinessResponse({}).ok, true);
  assert.equal(parseBusinessResponse({ message_id: '18446744073709551615' }).ok, true);
  assert.equal(parseBusinessResponse({ errmsg: '' }).ok, true);
  assert.equal(parseBusinessResponse({ errcode: 0 }).ok, true);
  assert.equal(parseBusinessResponse({ errcode: -14 }).ok, false);
  assert.equal(parseBusinessResponse({ ret: 500 }).ok, false);
  assert.equal(parseBusinessResponse({ ret: 0, errcode: -14 }).ok, false);
  assert.throws(() => parseBusinessResponse({ ret: '0' }));
});
