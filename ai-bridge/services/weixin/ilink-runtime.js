import {
  ILINK_DEFAULT_API_BASE_URL,
  normalizeIlinkBaseUrl,
} from './ilink-contract.js';
import { IlinkClient, IlinkClientError } from './ilink-client.js';
import { IlinkPairingSession, IlinkPairingError } from './ilink-pairing.js';

const DEFAULT_PAIRING_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_QR_REFRESHES = 3;
// Keep the QR payload below the Java loopback frame limit after JSON/base64 overhead.
const MAX_QR_IMAGE_LENGTH = 32 * 1024;
const MAX_TEXT_LENGTH = 64 * 1024;
const ACTIVE_PAIRING_STATES = new Set([
  'WAITING_SCAN',
  'SCANNED',
  'NEED_VERIFY_CODE',
  'REDIRECTING',
]);

/**
 * Owns the in-memory iLink session for the isolated bridge process.
 * Credentials are accepted only as an invocation input and are never returned
 * by status() or written to the bridge process output except for a pairing
 * response consumed immediately by the Java handoff.
 */
export class IlinkRuntime {
  constructor({
    clientFactory = (options) => new IlinkClient({ enabled: true, ...options, sendRetries: 0 }),
    clock = () => Date.now(),
    pairingTimeoutMs = DEFAULT_PAIRING_TIMEOUT_MS,
    maxQrRefreshes = DEFAULT_MAX_QR_REFRESHES,
  } = {}) {
    if (typeof clientFactory !== 'function' || typeof clock !== 'function') {
      throw new TypeError('iLink runtime dependencies are invalid');
    }
    this.clientFactory = clientFactory;
    this.clock = clock;
    this.pairingTimeoutMs = pairingTimeoutMs;
    this.maxQrRefreshes = maxQrRefreshes;
    this.pairing = undefined;
    this.transport = undefined;
  }

  async startPairing({ baseUrl = ILINK_DEFAULT_API_BASE_URL } = {}) {
    if (this.pairing !== undefined) {
      throw new IlinkRuntimeError('ILINK_PAIRING_ALREADY_STARTED');
    }
    const normalizedBaseUrl = normalizeIlinkBaseUrl(baseUrl);
    const session = new IlinkPairingSession({
      client: this.clientFactory({ baseUrl: normalizedBaseUrl }),
      clock: this.clock,
      maxDurationMs: this.pairingTimeoutMs,
      maxQrRefreshes: this.maxQrRefreshes,
    });
    const expiresAt = this.clock() + this.pairingTimeoutMs;
    this.pairing = { session, expiresAt, attempt: 1 };
    try {
      return toPairingSnapshot(await session.start(), this.pairing);
    } catch (error) {
      this.pairing = undefined;
      throw error;
    }
  }

  async pollPairing({ verifyCode } = {}) {
    const active = this.requirePairing();
    const result = await active.session.poll({ verifyCode });
    const snapshot = toPairingSnapshot(result, active);
    if (result.credentials !== undefined) {
      this.pairing = undefined;
      return {
        ...snapshot,
        credentials: validateCredentials(result.credentials),
      };
    }
    if (!ACTIVE_PAIRING_STATES.has(result.state)) {
      this.pairing = undefined;
    }
    return snapshot;
  }

  cancelPairing() {
    if (this.pairing === undefined) {
      return { state: 'IDLE', refreshCount: 0 };
    }
    const snapshot = toPairingSnapshot(this.pairing.session.cancel(), this.pairing);
    this.pairing = undefined;
    return snapshot;
  }

  startTransport({ baseUrl, botToken, cursor = '' } = {}) {
    const normalizedBaseUrl = normalizeIlinkBaseUrl(baseUrl);
    requireOpaqueString(botToken, 'botToken', 16 * 1024);
    requireOpaqueString(cursor, 'cursor', 1024 * 1024, true);
    const client = this.clientFactory({ baseUrl: normalizedBaseUrl });
    this.transport = { client, botToken, cursor };
    return this.status();
  }

  stopTransport() {
    this.transport = undefined;
    return this.status();
  }

  async getUpdates({ cursor } = {}) {
    const transport = this.requireTransport();
    if (cursor !== undefined) {
      requireOpaqueString(cursor, 'cursor', 1024 * 1024, true);
      transport.cursor = cursor;
    }
    const result = await transport.client.getUpdates({
      botToken: transport.botToken,
      cursor: transport.cursor,
    });
    if (result.cursor !== undefined) {
      transport.cursor = result.cursor;
    }
    return {
      messages: result.messages,
      cursor: transport.cursor,
      receivedCount: result.receivedCount,
      droppedCount: result.droppedCount,
    };
  }

  async sendText({
    toUserId,
    clientId,
    text,
    contextToken,
    fromUserId = '',
    runId = '',
  } = {}) {
    const transport = this.requireTransport();
    requireOpaqueString(toUserId, 'toUserId', 512);
    requireOpaqueString(clientId, 'clientId', 512);
    requireText(text, MAX_TEXT_LENGTH);
    requireOpaqueString(contextToken, 'contextToken', 16 * 1024);
    requireOpaqueString(fromUserId, 'fromUserId', 512, true);
    requireOpaqueString(runId, 'runId', 512, true);
    return transport.client.sendText({
      botToken: transport.botToken,
      toUserId,
      clientId,
      text,
      contextToken,
      fromUserId,
      runId,
    });
  }

  status() {
    return {
      pairingState: this.pairing?.session.state ?? 'IDLE',
      pairingExpiresAt: this.pairing?.expiresAt ?? null,
      pairingAttempt: this.pairing?.attempt ?? 0,
      transportState: this.transport === undefined ? 'STOPPED' : 'READY',
    };
  }

  requirePairing() {
    if (this.pairing === undefined) {
      throw new IlinkRuntimeError('ILINK_PAIRING_NOT_STARTED');
    }
    return this.pairing;
  }

  requireTransport() {
    if (this.transport === undefined) {
      throw new IlinkRuntimeError('ILINK_TRANSPORT_NOT_STARTED');
    }
    return this.transport;
  }
}

export class IlinkRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IlinkRuntimeError';
    this.code = code;
  }
}

export function publicErrorCode(error) {
  if (error instanceof IlinkRuntimeError
    || error instanceof IlinkClientError
    || error instanceof IlinkPairingError) {
    return error.code;
  }
  return 'ILINK_OPERATION_FAILED';
}

export function publicErrorDetails(error) {
  if (!(error instanceof IlinkClientError)) {
    return undefined;
  }
  const details = [];
  if (Number.isFinite(error.ret)) {
    details.push(`ret=${error.ret}`);
  }
  if (Number.isFinite(error.errorCode)) {
    details.push(`errcode=${error.errorCode}`);
  }
  if (Number.isInteger(error.httpStatus)) {
    details.push(`http=${error.httpStatus}`);
  }
  if (Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0 && error.retryAfterMs <= 86_400_000) {
    details.push(`retryAfterMs=${error.retryAfterMs}`);
  }
  return details.length === 0 ? undefined : details.join(';');
}

function toPairingSnapshot(snapshot, active) {
  const result = {
    state: snapshot.state,
    refreshCount: snapshot.refreshCount,
  };
  if (snapshot.qrCodeImageContent !== undefined) {
    result.qrCodeImageContent = requireQrImage(snapshot.qrCodeImageContent);
  }
  if (snapshot.pollingBaseUrl !== undefined) {
    result.pollingBaseUrl = normalizeIlinkBaseUrl(snapshot.pollingBaseUrl);
  }
  if (active !== undefined && ACTIVE_PAIRING_STATES.has(snapshot.state)) {
    result.expiresAt = active.expiresAt;
  } else {
    result.expiresAt = null;
  }
  return result;
}

function validateCredentials(credentials) {
  if (credentials === null || typeof credentials !== 'object') {
    throw new IlinkRuntimeError('ILINK_PAIRING_CONFIRMATION_INVALID');
  }
  const result = {
    botToken: requireOpaqueString(credentials.botToken, 'botToken', 16 * 1024),
    botId: requireOpaqueString(credentials.botId, 'botId', 512),
    baseUrl: normalizeIlinkBaseUrl(credentials.baseUrl),
  };
  if (credentials.userId !== undefined && credentials.userId !== null) {
    result.userId = requireOpaqueString(credentials.userId, 'userId', 512);
  }
  return result;
}

function requireQrImage(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_QR_IMAGE_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new IlinkRuntimeError('ILINK_PAIRING_QR_INVALID');
  }
  const dataUri = /^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/]+={0,2})$/i.exec(value);
  if (dataUri) {
    return `data:image/${dataUri[1].toLowerCase()};base64,${dataUri[2]}`;
  }
  if (!/^[a-z0-9+/]+={0,2}$/i.test(value)) {
    throw new IlinkRuntimeError('ILINK_PAIRING_QR_INVALID');
  }
  const image = Buffer.from(value, 'base64');
  const isPng = image.length >= 8 && image.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const isGif = image.length >= 6 && ['GIF87a', 'GIF89a'].includes(image.toString('ascii', 0, 6));
  const isWebp = image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF'
    && image.toString('ascii', 8, 12) === 'WEBP';
  const mimeType = isPng ? 'png' : isJpeg ? 'jpeg' : isGif ? 'gif' : isWebp ? 'webp' : null;
  if (!mimeType) {
    throw new IlinkRuntimeError('ILINK_PAIRING_QR_INVALID');
  }
  return `data:image/${mimeType};base64,${value}`;
}

function requireOpaqueString(value, name, maxLength, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maxLength
    || (!allowEmpty && value.length === 0) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new IlinkRuntimeError(`ILINK_FIELD_INVALID_${name.toUpperCase()}`);
  }
  return value;
}

function requireText(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength
    || [...value].some((character) => {
      const code = character.codePointAt(0);
      return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d || code === 0x7f;
    })) {
    throw new IlinkRuntimeError('ILINK_FIELD_INVALID_TEXT');
  }
  return value;
}
