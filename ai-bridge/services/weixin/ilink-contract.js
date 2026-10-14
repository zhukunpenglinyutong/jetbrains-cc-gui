const MAX_LOCAL_CURSOR_LENGTH = 1024 * 1024;
const MAX_LOCAL_TEXT_LENGTH = 64 * 1024;
const MAX_LOCAL_MESSAGE_ID_LENGTH = 512;
const MAX_LOCAL_USER_ID_LENGTH = 512;
const MAX_LOCAL_CONTEXT_TOKEN_LENGTH = 16 * 1024;
const QR_STATUSES = new Set([
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'need_verifycode',
  'verify_code_blocked',
  'scaned_but_redirect',
  'binded_redirect',
]);

export const ILINK_REFERENCE_VERSION = '2.4.9';
export const ILINK_DEFAULT_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_TRUSTED_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*weixin\.qq\.com$/i;
export const ILINK_PATHS = Object.freeze({
  getQrCode: '/ilink/bot/get_bot_qrcode',
  getQrCodeStatus: '/ilink/bot/get_qrcode_status',
  getUpdates: '/ilink/bot/getupdates',
  sendMessage: '/ilink/bot/sendmessage',
});

export function normalizeIlinkBaseUrl(value = ILINK_DEFAULT_API_BASE_URL) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('iLink base URL must be a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new TypeError('iLink base URL must use HTTPS');
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('iLink base URL must not contain credentials, query, or fragment');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new TypeError('iLink base URL must not contain a path');
  }
  if (parsed.port || !ILINK_TRUSTED_HOST_PATTERN.test(parsed.hostname)) {
    throw new TypeError('iLink base URL is not an approved host');
  }
  return parsed.origin;
}

export function buildIlinkUrl(baseUrl, path, query = {}) {
  if (!Object.values(ILINK_PATHS).includes(path)) {
    throw new TypeError(`Unsupported iLink path: ${path}`);
  }
  const url = new URL(path, `${normalizeIlinkBaseUrl(baseUrl)}/`);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, String(value));
    }
  }
  return url.href;
}

export function encodeIlinkClientVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  if (!match) {
    throw new TypeError('iLink client version must use major.minor.patch');
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new RangeError('iLink client version components must fit in one byte');
  }
  return String((parts[0] << 16) | (parts[1] << 8) | parts[2]);
}

export function encodeWechatUin(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError('X-WECHAT-UIN must be an unsigned 32-bit integer');
  }
  return Buffer.from(String(value), 'utf8').toString('base64');
}

export function buildApplicationHeaders({ channelVersion, routeTag } = {}) {
  if (channelVersion === undefined) {
    throw new TypeError('iLink channel version is required');
  }
  const headers = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': encodeIlinkClientVersion(channelVersion),
  };
  if (routeTag !== undefined && routeTag !== '') {
    if (typeof routeTag !== 'string' || /[\x00-\x1f\x7f]/.test(routeTag)) {
      throw new TypeError('iLink route tag must be a single-line string');
    }
    headers.SKRouteTag = String(routeTag);
  }
  return headers;
}

export function buildQrCodeHeaders({ channelVersion, routeTag, wechatUin } = {}) {
  if (wechatUin === undefined) {
    throw new TypeError('X-WECHAT-UIN is required for QR requests');
  }
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    ...buildApplicationHeaders({ channelVersion, routeTag }),
  };
  headers['X-WECHAT-UIN'] = encodeWechatUin(wechatUin);
  return headers;
}

export function buildAuthenticatedHeaders({
  botToken,
  channelVersion,
  routeTag,
  wechatUin,
} = {}) {
  if (typeof botToken !== 'string' || botToken.length === 0 || /[\x00-\x1f\x7f]/.test(botToken)) {
    throw new TypeError('iLink bot token is required');
  }
  if (wechatUin === undefined) {
    throw new TypeError('X-WECHAT-UIN is required for authenticated requests');
  }
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${botToken}`,
    ...buildApplicationHeaders({ channelVersion, routeTag }),
  };
  headers['X-WECHAT-UIN'] = encodeWechatUin(wechatUin);
  return headers;
}

export function buildBaseInfo({ channelVersion, botAgent = 'CCGUI/1.0.0' } = {}) {
  if (typeof channelVersion !== 'string' || !/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(channelVersion)) {
    throw new TypeError('iLink channel version must use major.minor.patch');
  }
  if (typeof botAgent !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(botAgent)) {
    throw new TypeError('iLink bot agent must use ASCII Name/Version');
  }
  if (Buffer.byteLength(botAgent, 'utf8') > 256) {
    throw new RangeError('iLink bot agent must be at most 256 bytes');
  }
  return {
    channel_version: String(channelVersion),
    bot_agent: botAgent,
  };
}

export function buildQrCodeRequest({
  baseUrl = ILINK_DEFAULT_API_BASE_URL,
  channelVersion,
  routeTag,
  wechatUin,
  localTokenList = [],
} = {}) {
  if (!Array.isArray(localTokenList)) {
    throw new TypeError('local token list must be an array');
  }
  const tokens = localTokenList.slice(-10);
  if (tokens.some((token) => typeof token !== 'string')) {
    throw new TypeError('local token list must contain strings');
  }
  return {
    method: 'POST',
    url: buildIlinkUrl(baseUrl, ILINK_PATHS.getQrCode, { bot_type: 3 }),
    headers: buildQrCodeHeaders({ channelVersion, routeTag, wechatUin }),
    body: { local_token_list: tokens },
  };
}

export function buildQrCodeStatusRequest({
  baseUrl,
  channelVersion,
  routeTag,
  qrcode,
  verifyCode,
} = {}) {
  requireString(qrcode, 'qrcode');
  if (verifyCode !== undefined && verifyCode !== null) {
    requireSafeBoundedString(verifyCode, 'verify_code', 128);
  }
  return {
    method: 'GET',
    url: buildIlinkUrl(baseUrl, ILINK_PATHS.getQrCodeStatus, {
      qrcode,
      verify_code: verifyCode,
    }),
    headers: buildApplicationHeaders({ channelVersion, routeTag }),
  };
}

export function parseQrCodeResponse(payload) {
  const value = requireObject(payload, 'QR code response');
  return {
    qrcode: requireString(value.qrcode, 'qrcode'),
    qrcodeImageContent: requireString(value.qrcode_img_content, 'qrcode_img_content'),
  };
}

export function parseQrCodeStatusResponse(payload) {
  const value = requireObject(payload, 'QR status response');
  const status = requireString(value.status, 'status');
  if (!QR_STATUSES.has(status)) {
    throw new Error(`Unsupported iLink QR status: ${status}`);
  }
  if (status === 'confirmed') {
    requireString(value.bot_token, 'bot_token');
    requireString(value.ilink_bot_id, 'ilink_bot_id');
  }
  return {
    status,
    botToken: optionalString(value.bot_token),
    botId: optionalString(value.ilink_bot_id),
    baseUrl: optionalApprovedBaseUrl(value.baseurl),
    redirectHost: optionalApprovedRedirectHost(value.redirect_host),
    userId: optionalString(value.ilink_user_id),
  };
}

export function buildGetUpdatesRequest({
  baseUrl,
  botToken,
  channelVersion,
  botAgent,
  routeTag,
  wechatUin,
  cursor = '',
} = {}) {
  requireSafeBoundedString(cursor, 'get_updates_buf', MAX_LOCAL_CURSOR_LENGTH, true);
  return {
    method: 'POST',
    url: buildIlinkUrl(baseUrl, ILINK_PATHS.getUpdates),
    headers: buildAuthenticatedHeaders({ botToken, channelVersion, routeTag, wechatUin }),
    body: {
      get_updates_buf: cursor,
      base_info: buildBaseInfo({ channelVersion, botAgent }),
    },
  };
}

export function parseIlinkJson(text) {
  const tokens = /("(?:\\[\s\S]|[^"\\])*")(\s*:\s*)(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])|"(?:\\[\s\S]|[^"\\])*"/g;
  return JSON.parse(text.replace(tokens, (match, key, separator, number) => {
    if (key !== undefined && JSON.parse(key) === 'message_id' && /^(?:0|[1-9]\d*)$/.test(number)) {
      return `${key}${separator}"${number}"`;
    }
    return match;
  }));
}

export function parseGetUpdatesResponse(payload) {
  const value = requireObject(payload, 'getUpdates response');
  const cursor = optionalBoundedString(value.get_updates_buf, MAX_LOCAL_CURSOR_LENGTH, 'get_updates_buf');
  if (value.msgs !== undefined && !Array.isArray(value.msgs)) {
    throw new TypeError('msgs must be an array');
  }
  const rawMessages = value.msgs ?? [];
  const messages = rawMessages.map(normalizeInboundMessage).filter((message) => message !== undefined);
  return {
    ret: optionalNumber(value.ret),
    errorCode: optionalNumber(value.errcode),
    errorMessage: optionalString(value.errmsg),
    ok: (value.ret === undefined || value.ret === 0)
      && (value.errcode === undefined || value.errcode === 0),
    messages,
    receivedCount: rawMessages.length,
    droppedCount: rawMessages.length - messages.length,
    cursor: cursor || undefined,
    longPollingTimeoutMs: optionalNumber(value.longpolling_timeout_ms),
  };
}

function normalizeInboundMessage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const rawMessageId = value.message_id;
  const messageId = readBoundedString(
    Number.isSafeInteger(rawMessageId) && rawMessageId >= 0 ? String(rawMessageId) : rawMessageId,
    MAX_LOCAL_MESSAGE_ID_LENGTH,
  );
  const fromUserId = readBoundedString(value.from_user_id, MAX_LOCAL_USER_ID_LENGTH);
  const contextToken = readBoundedString(value.context_token, MAX_LOCAL_CONTEXT_TOKEN_LENGTH);
  if (messageId === undefined || fromUserId === undefined || contextToken === undefined) {
    return undefined;
  }
  if (containsUnsupportedInboundItem(value.item_list)) {
    return { messageId, fromUserId, contextToken, text: '', action: 'UNSUPPORTED_MEDIA' };
  }
  const text = extractInboundText(value.item_list);
  if (text === undefined) {
    return undefined;
  }
  return { messageId, fromUserId, contextToken, text };
}

function containsUnsupportedInboundItem(items) {
  return Array.isArray(items) && items.some((item) => item !== null && typeof item === 'object'
    && !Array.isArray(item) && item.type !== 1);
}

function extractInboundText(items) {
  if (!Array.isArray(items)) {
    return undefined;
  }
  const parts = [];
  let length = 0;
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || item.type !== 1) {
      continue;
    }
    const text = item.text_item?.text;
    if (typeof text !== 'string' || text.length === 0 || hasDisallowedControl(text)) {
      continue;
    }
    length += text.length + (parts.length === 0 ? 0 : 1);
    if (length > MAX_LOCAL_TEXT_LENGTH) {
      return undefined;
    }
    parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join('\n');
}

function readBoundedString(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength
  || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value;
}

function hasDisallowedControl(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d || code === 0x7f;
  });
}

export function buildSendTextMessageRequest({
  baseUrl,
  botToken,
  channelVersion,
  botAgent,
  routeTag,
  wechatUin,
  toUserId,
  clientId,
  text,
  contextToken,
  fromUserId = '',
  runId,
} = {}) {
  requireSafeBoundedString(toUserId, 'to_user_id', MAX_LOCAL_USER_ID_LENGTH);
  requireSafeBoundedString(clientId, 'client_id', MAX_LOCAL_MESSAGE_ID_LENGTH);
  requireTextValue(text, 'text', MAX_LOCAL_TEXT_LENGTH);
  requireSafeBoundedString(contextToken, 'context_token', MAX_LOCAL_CONTEXT_TOKEN_LENGTH);
  if (fromUserId !== '') {
    requireSafeBoundedString(fromUserId, 'from_user_id', MAX_LOCAL_USER_ID_LENGTH);
  }
  const message = {
    from_user_id: fromUserId,
    to_user_id: toUserId,
    client_id: clientId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
  };
  message.context_token = contextToken;
  if (runId !== undefined && runId !== '') {
    requireSafeBoundedString(runId, 'run_id', MAX_LOCAL_MESSAGE_ID_LENGTH);
    message.run_id = runId;
  }
  return {
    method: 'POST',
    url: buildIlinkUrl(baseUrl, ILINK_PATHS.sendMessage),
    headers: buildAuthenticatedHeaders({ botToken, channelVersion, routeTag, wechatUin }),
    body: {
      msg: message,
      base_info: buildBaseInfo({ channelVersion, botAgent }),
    },
  };
}

export function parseBusinessResponse(payload) {
  const value = requireObject(payload, 'iLink response');
  return {
    ret: optionalNumber(value.ret),
    errorCode: optionalNumber(value.errcode),
    errorMessage: optionalString(value.errmsg),
    ok: (value.ret === undefined || value.ret === 0)
      && (value.errcode === undefined || value.errcode === 0),
  };
}

export function redactIlinkUrl(value) {
  const url = new URL(value);
  for (const name of ['qrcode', 'verify_code']) {
    if (url.searchParams.has(name)) {
      url.searchParams.set(name, '[REDACTED]');
    }
  }
  return url.href;
}

export function redactIlinkHeaders(headers) {
  const result = { ...headers };
  for (const name of ['Authorization', 'X-WECHAT-UIN']) {
    if (result[name] !== undefined) {
      result[name] = '[REDACTED]';
    }
  }
  return result;
}

function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireSafeBoundedString(value, name, maxLength, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.length === 0)
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must be a bounded single-line string`);
  }
  return value;
}

function requireTextValue(value, name, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength
    || hasDisallowedControl(value)) {
    throw new TypeError(`${name} must be a bounded text string`);
  }
  return value;
}

function optionalBoundedString(value, maxLength, name) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must be a bounded single-line string`);
  }
  return value;
}

function optionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new TypeError('field must be a string');
  }
  return value;
}

function optionalApprovedBaseUrl(value) {
  const text = optionalString(value);
  if (text === undefined || text === '') {
    return undefined;
  }
  return normalizeIlinkBaseUrl(text.startsWith('https://') ? text : `https://${text}`);
}

function optionalApprovedRedirectHost(value) {
  const host = optionalString(value);
  if (host === undefined || host === '') {
    return undefined;
  }
  if (!ILINK_TRUSTED_HOST_PATTERN.test(host)) {
    throw new TypeError('iLink redirect host is not approved');
  }
  return normalizeIlinkBaseUrl(`https://${host}`);
}

function optionalNumber(value) {
  return value === undefined || value === null ? undefined : requireFiniteNumber(value);
}

function requireFiniteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('numeric field must be a finite number');
  }
  return value;
}
