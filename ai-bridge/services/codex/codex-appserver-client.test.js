import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { CodexAppServerClient } from './codex-appserver-client.js';

function createFakeAppServer({ completeTurn = true } = {}) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const reverseResponses = [];
  let input = '';

  child.exitCode = null;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      input += chunk.toString();
      const lines = input.split('\n');
      input = lines.pop() || '';
      try {
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (!request.method && Object.hasOwn(request, 'id')) {
            reverseResponses.push(request);
            continue;
          }
          if (!Object.hasOwn(request, 'id')) continue;

          const result = request.method === 'thread/start'
            ? { thread: { id: 'thread-1' } }
            : request.method === 'turn/start'
              ? { turn: { id: 'turn-1' } }
              : {};
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);

          if (request.method === 'turn/start') {
            if (!completeTurn) continue;
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 'server-request-1',
              method: 'item/tool/requestUserInput',
              params: {
                questions: [{ id: 'q1', question: 'Choose one', header: 'Choice', options: [] }],
              },
            })}\n`);
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 'dynamic-tool-request-1',
              method: 'item/tool/call',
              params: {
                callId: 'call-1',
                tool: 'cc_gui_request_user_input',
                arguments: { questions: [{ title: 'Choose one', options: ['A', 'B'] }] },
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            })}\n`);
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'item/agentMessage/delta',
              params: { threadId: 'other-thread', turnId: 'other-turn', itemId: 'ignored', delta: 'x' },
            })}\n`);
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Hello' },
            })}\n`);
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: { threadId: 'thread-1', turnId: 'turn-1' },
            })}\n`);
          }
        }
      } catch (error) {
        callback(error);
        return;
      }
      callback();
    },
  });

  return {
    child,
    send(notification) {
      stdout.write(`${JSON.stringify(notification)}\n`);
    },
    reverseResponses,
    finish() {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      stdout.end();
      stderr.end();
    },
  };
}

test('Codex app-server client frames JSON-RPC and filters notifications by active turn', async () => {
  const fake = createFakeAppServer();
  const reverseRequests = [];
  let spawnArguments;
  const client = new CodexAppServerClient({
    executablePath: 'fake-codex',
    spawnProcess: (...args) => {
      spawnArguments = args;
      return fake.child;
    },
    onReverseRequest: async (method, params) => {
      reverseRequests.push({ method, params });
      return method === 'item/tool/requestUserInput'
        ? { answers: { q1: { answers: ['A'] } } }
        : method === 'item/tool/call'
          ? { success: true, contentItems: [{ type: 'inputText', text: '{"answers":{"Choose one":"B"}}' }] }
          : { decision: 'accept' };
    },
  });

  try {
    await client.initialize();
    const started = await client.startThread({ cwd: 'fixture' });
    assert.equal(started.thread.id, 'thread-1');
    assert.equal(spawnArguments[0], 'fake-codex');
    assert.deepEqual(spawnArguments[1], ['app-server', '--stdio']);

    const notifications = [];
    for await (const notification of client.streamTurn('thread-1', [{ type: 'text', text: 'hello' }])) {
      notifications.push(notification);
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(notifications.map((notification) => notification.method), [
      'item/agentMessage/delta',
      'turn/completed',
    ]);
    assert.deepEqual(reverseRequests, [{
      method: 'item/tool/requestUserInput',
      params: {
        questions: [{ id: 'q1', question: 'Choose one', header: 'Choice', options: [] }],
      },
    }, {
      method: 'item/tool/call',
      params: {
        callId: 'call-1',
        tool: 'cc_gui_request_user_input',
        arguments: { questions: [{ title: 'Choose one', options: ['A', 'B'] }] },
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    }]);
    assert.deepEqual(fake.reverseResponses, [
      {
        id: 'server-request-1',
        result: { answers: { q1: { answers: ['A'] } } },
      },
      {
        id: 'dynamic-tool-request-1',
        result: { success: true, contentItems: [{ type: 'inputText', text: '{"answers":{"Choose one":"B"}}' }] },
      },
    ]);
  } finally {
    fake.finish();
    client.close();
  }
});

test('idle app-server turns poll the session and release waiters on completion', async () => {
  const fake = createFakeAppServer({ completeTurn: false });
  const client = new CodexAppServerClient({ executablePath: 'fake', spawnProcess: () => fake.child });
  try {
    const stream = client.streamTurn('thread-1', [{ type: 'text', text: 'ask' }]);
    const poll = await stream.next();
    assert.equal(poll.value.method, 'ccgui/sessionPoll');
    assert.equal(client.activeTurnId, 'turn-1');
    assert.equal(client.notificationWaiters.length, 0);
    fake.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
    assert.equal(client.activeTurnId, null);
    assert.equal((await stream.next()).value.method, 'turn/completed');
    assert.equal((await stream.next()).done, true);
    assert.equal(client.notificationWaiters.length, 0);
  } finally {
    fake.finish();
    client.close();
  }
});

test('closing the app-server rejects and clears an idle notification waiter', async () => {
  const fake = createFakeAppServer({ completeTurn: false });
  const client = new CodexAppServerClient({ executablePath: 'fake', spawnProcess: () => fake.child });
  try {
    client.start();
    const pending = client.nextNotification(500);
    const waiter = client.notificationWaiters[0];
    const rejection = assert.rejects(pending, /exited/);
    fake.finish();
    await rejection;
    assert.equal(client.notificationWaiters.length, 0);
    assert.equal(waiter.timer._destroyed, true);
  } finally {
    client.close();
  }
});
