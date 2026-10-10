import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';

import {
  ILINK_REFERENCE_VERSION,
  buildGetUpdatesRequest,
  buildQrCodeRequest,
  buildQrCodeStatusRequest,
  buildSendTextMessageRequest,
  parseBusinessResponse,
  parseGetUpdatesResponse,
  parseIlinkJson,
  parseQrCodeResponse,
  parseQrCodeStatusResponse,
} from './ilink-contract.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_GET_UPDATES_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_SEND_RETRIES = 4;
const DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS = 1_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60_000;
const RATE_LIMIT_ERROR_CODE = 429;
const RATE_LIMIT_HTTP_STATUS = 429;
const RATE_LIMIT_MESSAGE = /(?:rate.?limit|too many requests|request frequency exceeded|\u9650\u6d41|\u9891\u7387\u8d85\u9650|\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41)/i;

export class IlinkClientError extends Error {
  constructor(code, { httpStatus, ret, errorCode, errorMessage, retryAfterMs } = {}) {
    super(code);
    this.name = 'IlinkClientError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.ret = ret;
    this.errorCode = errorCode;
    this.errorMessage = errorMessage;
    this.retryAfterMs = retryAfterMs;
  }
}

export class IlinkClient {
  constructor({
    enabled = false,
    baseUrl,
    channelVersion = ILINK_REFERENCE_VERSION,
    botAgent = 'CCGUI/1.0.0',
    routeTag,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    getUpdatesTimeoutMs = DEFAULT_GET_UPDATES_TIMEOUT_MS,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    sendRetries = DEFAULT_SEND_RETRIES,
    rateLimitBackoffBaseMs = DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS,
    fetchImpl = globalThis.fetch,
    wechatUinFactory = () => randomInt(0, 0x1_0000_0000),
  } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new RangeError('iLink timeout must be between 1 and 120000 milliseconds');
    }
    if (!Number.isInteger(getUpdatesTimeoutMs) || getUpdatesTimeoutMs < 1 || getUpdatesTimeoutMs > 120_000) {
      throw new RangeError('iLink getUpdates timeout must be between 1 and 120000 milliseconds');
    }
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
      throw new RangeError('iLink response size limit is invalid');
    }
    if (!Number.isInteger(sendRetries) || sendRetries < 0 || sendRetries > 8) {
      throw new RangeError('iLink send retries must be between 0 and 8');
    }
    if (!Number.isInteger(rateLimitBackoffBaseMs)
      || rateLimitBackoffBaseMs < 1 || rateLimitBackoffBaseMs > MAX_RATE_LIMIT_BACKOFF_MS) {
      throw new RangeError('iLink rate-limit backoff must be between 1 and 60000 milliseconds');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('Fetch API is required');
    }

    this.enabled = enabled === true;
    this.baseUrl = baseUrl;
    this.channelVersion = channelVersion;
    this.botAgent = botAgent;
    this.routeTag = routeTag;
    this.timeoutMs = timeoutMs;
    this.getUpdatesTimeoutMs = getUpdatesTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.sendRetries = sendRetries;
    this.rateLimitBackoffBaseMs = rateLimitBackoffBaseMs;
    this.fetchImpl = fetchImpl;
    this.wechatUinFactory = wechatUinFactory;
    this.sendTail = Promise.resolve();
  }

  async getQrCode({ localTokenList, signal } = {}) {
    this.ensureEnabled();
    const request = buildQrCodeRequest({
      baseUrl: this.baseUrl,
      channelVersion: this.channelVersion,
      routeTag: this.routeTag,
      wechatUin: this.wechatUinFactory(),
      localTokenList,
    });
    const qr = parseQrCodeResponse(await this.#sendJson(request, { signal }));
    if (!qr.qrcodeImageContent.startsWith('https://')) {
      return qr;
    }
    let qrUrl;
    try {
      qrUrl = new URL(qr.qrcodeImageContent);
    } catch {
      throw new IlinkClientError('ILINK_PAIRING_QR_INVALID');
    }
    if (qr.qrcodeImageContent.length > 2048 || qrUrl.hostname !== 'liteapp.weixin.qq.com'
      || qrUrl.username || qrUrl.password || qrUrl.hash) {
      throw new IlinkClientError('ILINK_PAIRING_QR_INVALID');
    }
    try {
      return {
        ...qr,
        qrcodeImageContent: await QRCode.toDataURL(qr.qrcodeImageContent, {
          errorCorrectionLevel: 'M', margin: 2, width: 256,
        }),
      };
    } catch {
      throw new IlinkClientError('ILINK_PAIRING_QR_INVALID');
    }
  }

  async getQrCodeStatus({ baseUrl = this.baseUrl, qrcode, verifyCode, signal } = {}) {
    this.ensureEnabled();
    const request = buildQrCodeStatusRequest({
      baseUrl,
      channelVersion: this.channelVersion,
      routeTag: this.routeTag,
      qrcode,
      verifyCode,
    });
    return parseQrCodeStatusResponse(await this.#sendJson(request, { signal }));
  }

  async getUpdates({ botToken, cursor = '', signal } = {}) {
    this.ensureEnabled();
    const request = buildGetUpdatesRequest({
      baseUrl: this.baseUrl,
      botToken,
      channelVersion: this.channelVersion,
      botAgent: this.botAgent,
      routeTag: this.routeTag,
      wechatUin: this.wechatUinFactory(),
      cursor,
    });
    let response;
    try {
      response = await this.#sendJson(request, {
        signal,
        operation: 'GET_UPDATES',
        timeoutMs: this.getUpdatesTimeoutMs,
      });
    } catch (error) {
      if (error instanceof IlinkClientError && error.code === 'ILINK_GET_UPDATES_TIMEOUT') {
        return parseGetUpdatesResponse({ ret: 0, msgs: [], get_updates_buf: cursor });
      }
      throw error;
    }
    const result = parseGetUpdatesResponse(response);
    if (!result.ok) {
      if (result.ret === -14 || result.errorCode === -14
        || result.errorCode === 401 || result.errorCode === 403) {
        throw new IlinkClientError('ILINK_AUTH_REJECTED', {
          ret: result.ret,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        });
      }
      throw new IlinkClientError('ILINK_GET_UPDATES_REJECTED', {
        ret: result.ret,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      });
    }
    return result;
  }

  async sendText({
    botToken,
    toUserId,
    clientId,
    text,
    contextToken,
    fromUserId,
    runId,
    signal,
  } = {}) {
    const send = () => this.#sendTextWithRetry({
      botToken,
      toUserId,
      clientId,
      text,
      contextToken,
      fromUserId,
      runId,
      signal,
    });
    // iLink applies limits to the bot, so concurrent sends from progress and
    // terminal paths can create an avoidable burst. Keep the wire order stable.
    const current = this.sendTail.then(send, send);
    this.sendTail = current.catch(() => undefined);
    return current;
  }

  async #sendTextWithRetry({
    botToken,
    toUserId,
    clientId,
    text,
    contextToken,
    fromUserId,
    runId,
    signal,
  }) {
    this.ensureEnabled();
    for (let attempt = 0; ; attempt += 1) {
      const request = buildSendTextMessageRequest({
        baseUrl: this.baseUrl,
        botToken,
        channelVersion: this.channelVersion,
        botAgent: this.botAgent,
        routeTag: this.routeTag,
        wechatUin: this.wechatUinFactory(),
        toUserId,
        clientId,
        text,
        contextToken,
        fromUserId,
        runId,
      });
      let response;
      try {
        response = await this.#requestJson(request, { signal, operation: 'SEND' });
      } catch (error) {
        if (!isRetryableSendError(error) || attempt >= this.sendRetries) {
          throw error;
        }
        await waitForRetry(this.rateLimitBackoffBaseMs, attempt, signal);
        continue;
      }
      let result;
      try {
        result = parseBusinessResponse(response);
      } catch {
        throw new IlinkClientError('ILINK_SEND_RESULT_UNKNOWN');
      }
      if (result.ok) {
        return result;
      }
      const error = new IlinkClientError(isRateLimitResult(result) ? 'ILINK_SEND_RATE_LIMITED' : 'ILINK_SEND_REJECTED', {
        ret: result.ret,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      });
      if (!isRateLimitResult(result) || attempt >= this.sendRetries) {
        throw error;
      }
      await waitForRetry(this.rateLimitBackoffBaseMs, attempt, signal);
    }
  }

  ensureEnabled() {
    if (!this.enabled) {
      throw new IlinkClientError('ILINK_TRANSPORT_DISABLED');
    }
  }

  async #sendJson(request, { signal, operation = 'READ', timeoutMs = this.timeoutMs } = {}) {
    return this.#requestJson(request, { signal, operation, timeoutMs });
  }

  async #requestJson(request, { signal, operation, timeoutMs = this.timeoutMs } = {}) {
    this.ensureEnabled();
    const controller = new AbortController();
    let requestTimedOut = false;
    const timeout = setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromCaller = () => controller.abort(signal.reason);
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener('abort', abortFromCaller, { once: true });
    }

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw new IlinkClientError(
          operation === 'SEND'
            ? (response.status === 429 ? 'ILINK_SEND_RATE_LIMITED' : 'ILINK_SEND_RESULT_UNKNOWN')
            : (response.status === 401 || response.status === 403
              ? 'ILINK_AUTH_REJECTED' : 'ILINK_HTTP_STATUS'),
          { httpStatus: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) },
        );
      }
      const contentType = response.headers.get('content-type') || '';
      const text = await readBoundedResponse(response, this.maxResponseBytes);
      const hasJsonContentType = /^(?:application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i
        .test(contentType.trim());
      try {
        return parseIlinkJson(text);
      } catch {
        if (!hasJsonContentType) {
          throw new IlinkClientError(operation === 'SEND'
            ? 'ILINK_SEND_RESULT_UNKNOWN' : 'ILINK_RESPONSE_CONTENT_TYPE_INVALID');
        }
        throw new IlinkClientError(operation === 'SEND'
          ? 'ILINK_SEND_RESULT_UNKNOWN' : 'ILINK_RESPONSE_JSON_INVALID');
      }
    } catch (error) {
      if (error instanceof IlinkClientError) {
        if (operation === 'SEND' && error.code !== 'ILINK_SEND_RESULT_UNKNOWN' && error.code !== 'ILINK_SEND_RATE_LIMITED') {
          throw new IlinkClientError('ILINK_SEND_RESULT_UNKNOWN', { httpStatus: error.httpStatus });
        }
        throw error;
      }
      if (controller.signal.aborted) {
        if (signal?.aborted) {
          throw new IlinkClientError(operation === 'SEND'
            ? 'ILINK_SEND_RESULT_UNKNOWN' : 'ILINK_REQUEST_ABORTED');
        }
        if (operation === 'GET_UPDATES' && requestTimedOut) {
          throw new IlinkClientError('ILINK_GET_UPDATES_TIMEOUT');
        }
        throw new IlinkClientError(operation === 'SEND'
          ? 'ILINK_SEND_RESULT_UNKNOWN' : 'ILINK_REQUEST_ABORTED');
      }
      throw new IlinkClientError(operation === 'SEND'
        ? 'ILINK_SEND_RESULT_UNKNOWN' : 'ILINK_REQUEST_FAILED');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

function isRateLimitResult(result) {
  return result.ret === RATE_LIMIT_ERROR_CODE
    || result.errorCode === RATE_LIMIT_ERROR_CODE
    || RATE_LIMIT_MESSAGE.test(result.errorMessage || '');
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  const delay = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(86_400_000, Math.ceil(delay)) : undefined;
}

function isRetryableSendError(error) {
  return error instanceof IlinkClientError && error.httpStatus === RATE_LIMIT_HTTP_STATUS;
}

function waitForRetry(baseDelayMs, attempt, signal) {
  const delayMs = Math.min(MAX_RATE_LIMIT_BACKOFF_MS, baseDelayMs * (2 ** attempt));
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new IlinkClientError('ILINK_SEND_RESULT_UNKNOWN'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function readBoundedResponse(response, maxBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    throw new IlinkClientError('ILINK_RESPONSE_TOO_LARGE');
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new IlinkClientError('ILINK_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
