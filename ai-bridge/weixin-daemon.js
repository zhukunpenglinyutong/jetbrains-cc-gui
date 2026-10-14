import readline from 'node:readline';

import {
  IlinkRuntime,
  publicErrorCode,
  publicErrorDetails,
} from './services/weixin/ilink-runtime.js';

const MAX_LINE_LENGTH = 256 * 1024;
const runtime = new IlinkRuntime();
let queue = Promise.resolve();

process.stdout.write(`${JSON.stringify({ type: 'daemon', event: 'ready' })}\n`);

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on('line', (line) => {
  if (isConcurrentMethod(line, 'send_text')) {
    void handleLine(line);
    return;
  }
  queue = queue.then(() => handleLine(line)).catch(() => undefined);
});

input.on('close', () => {
  queue.finally(() => process.exit(0));
});

async function handleLine(line) {
  if (line.length === 0 || line.length > MAX_LINE_LENGTH) {
    writeResponse(undefined, undefined, 'ILINK_DAEMON_REQUEST_INVALID');
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeResponse(undefined, undefined, 'ILINK_DAEMON_REQUEST_INVALID');
    return;
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)
    || typeof request.id !== 'string' || request.id.length === 0 || request.id.length > 256
    || typeof request.method !== 'string' || request.method.length === 0 || request.method.length > 64) {
    writeResponse(undefined, undefined, 'ILINK_DAEMON_REQUEST_INVALID');
    return;
  }

  try {
    const result = await dispatch(request.method, request.params);
    writeResponse(request.id, result);
    if (request.method === 'stop') {
      setImmediate(() => process.exit(0));
    }
  } catch (error) {
    writeResponse(request.id, undefined, publicErrorCode(error), publicErrorDetails(error));
  }
}

function isConcurrentMethod(line, method) {
  try {
    const request = JSON.parse(line);
    return request !== null && typeof request === 'object' && !Array.isArray(request)
      && request.method === method;
  } catch {
    return false;
  }
}

async function dispatch(method, params) {
  const values = params === undefined ? {} : params;
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('invalid params');
  }
  switch (method) {
    case 'start_pairing':
      return runtime.startPairing(values);
    case 'poll_pairing':
      return runtime.pollPairing(values);
    case 'cancel_pairing':
      return runtime.cancelPairing();
    case 'start_transport':
      return runtime.startTransport(values);
    case 'stop_transport':
      return runtime.stopTransport();
    case 'get_updates':
      return runtime.getUpdates(values);
    case 'send_text':
      return runtime.sendText(values);
    case 'status':
      return runtime.status();
    case 'stop':
      return runtime.stopTransport();
    default:
      throw new Error('unsupported method');
  }
}

function writeResponse(id, result, errorCode, errorDetail) {
  const response = { id };
  if (errorCode !== undefined) {
    response.error = { code: errorCode };
    if (errorDetail !== undefined) {
      response.error.detail = errorDetail;
    }
  } else {
    response.result = result;
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
