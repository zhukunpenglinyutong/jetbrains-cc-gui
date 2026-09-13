import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DshRpcError,
  DshTransportError,
  muxUrlFromOrigin,
  originFromHostPort,
  parseServerResponse,
} from './host.js';

test('originFromHostPort applies defaults', () => {
  assert.equal(originFromHostPort('', 0), 'http://127.0.0.1:3080');
  assert.equal(originFromHostPort('localhost', 4000), 'http://localhost:4000');
});

test('muxUrlFromOrigin maps http(s) → ws(s)', () => {
  assert.equal(muxUrlFromOrigin('http://127.0.0.1:3080'), 'ws://127.0.0.1:3080/api/events.mux');
  assert.equal(muxUrlFromOrigin('https://dsh.example.com/'), 'wss://dsh.example.com/api/events.mux');
});

test('parseServerResponse unwraps ok value', () => {
  const body = JSON.stringify({
    type: 'server-response',
    rpcId: 'rpc-1',
    result: { ok: true, value: { version: '0.0.1' } },
  });
  assert.deepEqual(parseServerResponse(body, 'rpc-1', 'host.describe'), { version: '0.0.1' });
});

test('parseServerResponse throws DshRpcError on ok:false', () => {
  const body = JSON.stringify({
    type: 'server-response',
    rpcId: 'rpc-2',
    result: {
      ok: false,
      error: { code: 'attachment-error', message: 'no images', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
    },
  });
  assert.throws(
    () => parseServerResponse(body, 'rpc-2', 'session.prompt'),
    (error) => {
      assert.ok(error instanceof DshRpcError);
      assert.equal(error.code, 'attachment-error');
      assert.equal(error.details.reason, 'MODEL_DOES_NOT_SUPPORT_IMAGES');
      return true;
    }
  );
});

test('parseServerResponse rejects envelope violations', () => {
  assert.throws(
    () => parseServerResponse(JSON.stringify({ type: 'server-request', rpcId: 'x' }), 'x', 'm'),
    DshTransportError
  );
  assert.throws(
    () => parseServerResponse(JSON.stringify({ type: 'server-response', rpcId: 'a', result: { ok: true, value: 1 } }), 'b', 'm'),
    /rpcId mismatch/
  );
  assert.throws(() => parseServerResponse('not json', 'x', 'm'), DshTransportError);
  assert.throws(
    () => parseServerResponse(JSON.stringify({ type: 'server-response', rpcId: 'x' }), 'x', 'm'),
    /missing result/
  );
});
