import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DshHostClient,
  DshHttpError,
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

/** Run `body` with `fetch` replaced by a recording stub. */
async function withFetch(handler, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url, init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return handler(call);
  };
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function okResponse(call, value) {
  return new Response(
    JSON.stringify({ type: 'server-response', rpcId: call.body.rpcId, result: { ok: true, value } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

test('a legacy client posts the business payload bare and sends no cookie', async () => {
  await withFetch((call) => okResponse(call, { version: '0.0.1' }), async (calls) => {
    const client = new DshHostClient('http://127.0.0.1:3080');
    await client.call('session.list', { cursor: 'c' });
    assert.equal(calls[0].url, 'http://127.0.0.1:3080/api/session.list');
    assert.equal(calls[0].body.method, 'session.list');
    assert.deepEqual(calls[0].body.payload, { cursor: 'c' });
    assert.equal(calls[0].init.headers.cookie, undefined);
    assert.equal(client.muxUrl(), 'ws://127.0.0.1:3080/api/events.mux');
  });
});

test('a modern client wraps args, mints the endpoint name and sends the cookie', async () => {
  await withFetch((call) => okResponse(call, { items: [] }), async (calls) => {
    const client = new DshHostClient('http://127.0.0.1:3080', {
      dialect: 'modern',
      cookie: 'dsh-auth-x=v1.a.b',
    });
    await client.call('session.list', {});
    assert.equal(calls[0].url, 'http://127.0.0.1:3080/api/session/list');
    assert.equal(calls[0].body.method, 'session/list');
    assert.deepEqual(calls[0].body.payload, { args: { _request: {} } });
    assert.equal(calls[0].init.headers.cookie, 'dsh-auth-x=v1.a.b');
    assert.equal(client.muxUrl(), 'ws://127.0.0.1:3080/api/remote.mux');
    assert.deepEqual(client.muxHeaders(), { cookie: 'dsh-auth-x=v1.a.b' });
  });
});

test('a modern describe falls back to the model catalog default', async () => {
  await withFetch(
    (call) => okResponse(call, {
      default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      groups: [],
    }),
    async (calls) => {
      const client = new DshHostClient('http://127.0.0.1:3080', { dialect: 'modern', cookie: 'c=1' });
      const describe = await client.describe();
      assert.equal(calls[0].url, 'http://127.0.0.1:3080/api/session/modelCatalog');
      assert.deepEqual(calls[0].body.payload, { args: {} });
      assert.equal(describe.model, 'deepseek-flash');
      assert.equal(describe.reasoningEffort, 'high');
    }
  );
});

test('a waterfall answer posts to $events/result with the result as args', async () => {
  await withFetch((call) => okResponse(call, undefined), async (calls) => {
    const client = new DshHostClient('http://127.0.0.1:3080', { dialect: 'modern', cookie: 'c=1' });
    await client.answerRemoteEvent('client-1', 'event-1', 'allowed-once');
    assert.equal(calls[0].url, 'http://127.0.0.1:3080/api/$events/result');
    assert.equal(calls[0].body.method, '$events/result');
    // The result object IS the args object — no named-parameter wrapper.
    assert.deepEqual(calls[0].body.payload, {
      args: {
        clientId: 'client-1',
        eventId: 'event-1',
        outcome: { kind: 'result', value: 'allowed-once' },
      },
    });
  });
});

test('a legacy respond still posts the client-response envelope', async () => {
  await withFetch(() => new Response('{}', { status: 200 }), async (calls) => {
    const client = new DshHostClient('http://127.0.0.1:3080');
    await client.respond('rpc-1', { sessionId: 's' });
    assert.equal(calls[0].url, 'http://127.0.0.1:3080/api/respond');
    assert.deepEqual(calls[0].body, {
      type: 'client-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { sessionId: 's' } },
    });
  });
});

test('a 401 surfaces as DshHttpError so negotiation can observe it', async () => {
  await withFetch(
    () => new Response('unauthorized', { status: 401 }),
    async () => {
      const client = new DshHostClient('http://127.0.0.1:3080');
      await assert.rejects(
        () => client.call('host.describe', {}),
        (error) => {
          assert.ok(error instanceof DshHttpError);
          assert.equal(error.status, 401);
          assert.match(error.message, /dsh HTTP 401/);
          return true;
        }
      );
    }
  );
});

test('an endpoint the dialect does not serve fails without a request', async () => {
  await withFetch(() => new Response('{}', { status: 200 }), async (calls) => {
    const client = new DshHostClient('http://127.0.0.1:3080', { dialect: 'modern', cookie: 'c=1' });
    await assert.rejects(() => client.call('host.describe', {}), /not available on this host/);
    assert.equal(calls.length, 0);
  });
});

