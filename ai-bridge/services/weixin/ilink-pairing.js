import { ILINK_DEFAULT_API_BASE_URL, normalizeIlinkBaseUrl } from './ilink-contract.js';

const DEFAULT_PAIRING_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_QR_REFRESHES = 3;
const ACTIVE_STATES = new Set([
  'WAITING_SCAN',
  'SCANNED',
  'NEED_VERIFY_CODE',
  'REDIRECTING',
]);
const TERMINAL_STATES = new Set([
  'BOUND',
  'ALREADY_BOUND',
  'EXPIRED',
  'VERIFY_CODE_BLOCKED',
  'TIMEOUT',
  'CANCELLED',
  'ERROR',
]);

export class IlinkPairingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IlinkPairingError';
    this.code = code;
  }
}

export class IlinkPairingSession {
  constructor({
    client,
    clock = () => Date.now(),
    maxDurationMs = DEFAULT_PAIRING_TIMEOUT_MS,
    maxQrRefreshes = DEFAULT_MAX_QR_REFRESHES,
  } = {}) {
    if (!client || typeof client.getQrCode !== 'function' || typeof client.getQrCodeStatus !== 'function') {
      throw new TypeError('iLink pairing client is required');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('iLink pairing clock must be a function');
    }
    if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 60 * 60_000) {
      throw new RangeError('iLink pairing timeout must be between 1 and 3600000 milliseconds');
    }
    if (!Number.isInteger(maxQrRefreshes) || maxQrRefreshes < 0 || maxQrRefreshes > 10) {
      throw new RangeError('iLink QR refresh count must be between 0 and 10');
    }

    this.client = client;
    this.clock = clock;
    this.maxDurationMs = maxDurationMs;
    this.maxQrRefreshes = maxQrRefreshes;
    this.state = 'IDLE';
    this.refreshCount = 0;
    this.deadline = undefined;
    this.qrcode = undefined;
    this.qrcodeImageContent = undefined;
    this.localTokenList = undefined;
    this.pollingBaseUrl = undefined;
  }

  async start({ localTokenList = [], signal } = {}) {
    this.requireState('IDLE', 'ILINK_PAIRING_ALREADY_STARTED');
    if (!Array.isArray(localTokenList)) {
      throw new TypeError('local token list must be an array');
    }

    const tokens = localTokenList.slice(-10);
    const deadline = this.clock() + this.maxDurationMs;
    const request = createDeadlineSignal(signal, deadline, this.clock);
    let qr;
    try {
      qr = await this.client.getQrCode({
        localTokenList: tokens,
        signal: request.signal,
      });
    } catch (error) {
      if (request.deadlineExpired && !signal?.aborted) {
        this.finish('TIMEOUT');
        return this.snapshot();
      }
      throw error;
    } finally {
      request.dispose();
    }
    if (request.deadlineExpired) {
      this.finish('TIMEOUT');
      return this.snapshot();
    }
    if (!qr || typeof qr.qrcode !== 'string' || qr.qrcode.length === 0
      || typeof qr.qrcodeImageContent !== 'string' || qr.qrcodeImageContent.length === 0) {
      throw new IlinkPairingError('ILINK_PAIRING_QR_INVALID');
    }

    this.qrcode = qr.qrcode;
    this.qrcodeImageContent = qr.qrcodeImageContent;
    this.localTokenList = [...tokens];
    this.refreshCount = 0;
    this.deadline = deadline;
    this.state = 'WAITING_SCAN';
    return this.snapshot();
  }

  async poll({ verifyCode, signal } = {}) {
    this.requireActive();
    if (this.clock() >= this.deadline) {
      this.finish('TIMEOUT');
      return this.snapshot();
    }

    const request = createDeadlineSignal(signal, this.deadline, this.clock);
    let result;
    try {
      result = await this.client.getQrCodeStatus({
        baseUrl: this.pollingBaseUrl,
        qrcode: this.qrcode,
        verifyCode,
        signal: request.signal,
      });
    } catch (error) {
      if (request.deadlineExpired && !signal?.aborted) {
        this.finish('TIMEOUT');
        return this.snapshot();
      }
      throw error;
    } finally {
      request.dispose();
    }
    if (request.deadlineExpired || this.clock() >= this.deadline) {
      this.finish('TIMEOUT');
      return this.snapshot();
    }
    if (!result || typeof result.status !== 'string') {
      this.finish('ERROR');
      throw new IlinkPairingError('ILINK_PAIRING_STATUS_INVALID');
    }

    switch (result.status) {
      case 'wait':
        this.state = 'WAITING_SCAN';
        return this.snapshot();
      case 'scaned':
        this.state = 'SCANNED';
        return this.snapshot();
      case 'need_verifycode':
        this.state = 'NEED_VERIFY_CODE';
        return this.snapshot();
      case 'scaned_but_redirect':
        if (result.redirectHost !== undefined) {
          try {
            this.pollingBaseUrl = normalizeIlinkBaseUrl(result.redirectHost);
          } catch {
            this.finish('ERROR');
            throw new IlinkPairingError('ILINK_PAIRING_REDIRECT_INVALID');
          }
        }
        this.state = 'REDIRECTING';
        return this.snapshot();
      case 'expired':
        return this.refreshQrCode(signal, 'EXPIRED');
      case 'verify_code_blocked':
        return this.refreshQrCode(signal, 'VERIFY_CODE_BLOCKED');
      case 'confirmed':
        return this.confirm(result);
      case 'binded_redirect':
        this.finish('ALREADY_BOUND');
        return this.snapshot();
      default:
        this.finish('ERROR');
        throw new IlinkPairingError('ILINK_PAIRING_STATUS_UNSUPPORTED');
    }
  }

  cancel() {
    if (this.state === 'IDLE' || ACTIVE_STATES.has(this.state)) {
      this.finish('CANCELLED');
    }
    return this.snapshot();
  }

  snapshot() {
    const snapshot = {
      state: this.state,
      refreshCount: this.refreshCount,
    };
    if (ACTIVE_STATES.has(this.state) && this.qrcodeImageContent !== undefined) {
      snapshot.qrCodeImageContent = this.qrcodeImageContent;
    }
    if (this.state === 'REDIRECTING' && this.pollingBaseUrl !== undefined) {
      snapshot.pollingBaseUrl = this.pollingBaseUrl;
    }
    return snapshot;
  }

  async refreshQrCode(signal, terminalState) {
    if (this.clock() >= this.deadline) {
      this.finish('TIMEOUT');
      return this.snapshot();
    }
    if (this.refreshCount >= this.maxQrRefreshes) {
      this.finish(terminalState);
      return this.snapshot();
    }

    const request = createDeadlineSignal(signal, this.deadline, this.clock);
    let qr;
    try {
      qr = await this.client.getQrCode({
        localTokenList: this.localTokenList ? [...this.localTokenList] : [],
        signal: request.signal,
      });
    } catch (error) {
      if (request.deadlineExpired && !signal?.aborted) {
        this.finish('TIMEOUT');
        return this.snapshot();
      }
      throw error;
    } finally {
      request.dispose();
    }
    if (request.deadlineExpired) {
      this.finish('TIMEOUT');
      return this.snapshot();
    }
    if (!qr || typeof qr.qrcode !== 'string' || qr.qrcode.length === 0
      || typeof qr.qrcodeImageContent !== 'string' || qr.qrcodeImageContent.length === 0) {
      this.finish('ERROR');
      throw new IlinkPairingError('ILINK_PAIRING_QR_INVALID');
    }

    this.qrcode = qr.qrcode;
    this.qrcodeImageContent = qr.qrcodeImageContent;
    this.refreshCount += 1;
    this.pollingBaseUrl = undefined;
    this.state = 'WAITING_SCAN';
    return this.snapshot();
  }

  confirm(result) {
    if (typeof result.botToken !== 'string' || result.botToken.length === 0
      || typeof result.botId !== 'string' || result.botId.length === 0) {
      this.finish('ERROR');
      throw new IlinkPairingError('ILINK_PAIRING_CONFIRMATION_INVALID');
    }
    let baseUrl;
    try {
      baseUrl = normalizeIlinkBaseUrl(
        result.baseUrl || this.pollingBaseUrl || ILINK_DEFAULT_API_BASE_URL,
      );
    } catch {
      this.finish('ERROR');
      throw new IlinkPairingError('ILINK_PAIRING_CONFIRMATION_INVALID');
    }
    const credentials = {
      botToken: result.botToken,
      botId: result.botId,
      baseUrl,
      userId: result.userId,
    };
    this.finish('BOUND');
    return { ...this.snapshot(), credentials };
  }

  requireActive() {
    if (this.state === 'IDLE') {
      throw new IlinkPairingError('ILINK_PAIRING_NOT_STARTED');
    }
    if (!ACTIVE_STATES.has(this.state)) {
      throw new IlinkPairingError('ILINK_PAIRING_TERMINAL');
    }
  }

  requireState(expected, code) {
    if (this.state !== expected) {
      throw new IlinkPairingError(code);
    }
  }

  finish(state) {
    this.state = state;
    this.qrcode = undefined;
    this.qrcodeImageContent = undefined;
    this.localTokenList = undefined;
    this.deadline = undefined;
    if (TERMINAL_STATES.has(state)) {
      this.pollingBaseUrl = undefined;
    }
  }
}

function createDeadlineSignal(parentSignal, deadline, clock) {
  const controller = new AbortController();
  let deadlineExpired = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const remainingMs = Math.max(deadline - clock(), 1);
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, remainingMs);
  return {
    signal: controller.signal,
    get deadlineExpired() {
      return deadlineExpired;
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}
