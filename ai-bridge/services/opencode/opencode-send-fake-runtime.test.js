import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { sendMessage } from './message-service.js';

async function withDiffServer(fn) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/session/ses_fake/diff')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[]');
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"error":"not found"}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function createEventQueue() {
  const events = [];
  const waiters = [];

  function wake() {
    while (waiters.length > 0) {
      waiters.shift()();
    }
  }

  return {
    push(...items) {
      events.push(...items);
      wake();
    },
    stream(signal) {
      return (async function* eventStream() {
        while (!signal.aborted || events.length > 0) {
          if (events.length > 0) {
            yield events.shift();
            continue;
          }
          await new Promise((resolve) => {
            waiters.push(resolve);
            signal.addEventListener('abort', resolve, { once: true });
          });
        }
      })();
    }
  };
}

async function captureBridgeOutput(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines = [];

  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  console.error = (...args) => {
    lines.push(args.join(' '));
  };
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line) lines.push(line);
    }
    return true;
  };

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
  return lines;
}

function markerPayloads(lines, marker) {
  const prefix = `${marker} `;
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)));
}

test('opencode sendMessage works against an injected async fake runtime', async () => {
  await withDiffServer(async (baseUrl) => {
    const queue = createEventQueue();
    let promptBody;
    let created = false;
    let promptStarted = false;
    const runtime = {
      baseUrl,
      client: {
        event: {
          subscribe: async ({ signal }) => ({ stream: queue.stream(signal) })
        },
        session: {
          create: async () => {
            created = true;
            return { data: { id: 'ses_fake' } };
          },
          status: async () => ({ data: { ses_fake: { type: 'idle' } } }),
          promptAsync: async ({ body }) => {
            promptStarted = true;
            promptBody = body;
            queue.push(
              { type: 'session.status', properties: { sessionID: 'ses_fake', status: { type: 'busy' } } },
              {
                type: 'message.updated',
                properties: { sessionID: 'ses_fake', info: { id: 'msg_assistant_1', role: 'assistant' } }
              },
              {
                type: 'message.part.delta',
                properties: {
                  sessionID: 'ses_fake',
                  messageID: 'msg_assistant_1',
                  partID: 'prt_text_1',
                  field: 'text',
                  delta: 'Fake response'
                }
              },
              {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'ses_fake',
                  part: {
                    id: 'prt_text_1',
                    sessionID: 'ses_fake',
                    messageID: 'msg_assistant_1',
                    type: 'text',
                    text: 'Fake response',
                    time: { start: 1, end: 2 }
                  }
                }
              },
              { type: 'session.status', properties: { sessionID: 'ses_fake', status: { type: 'idle' } } }
            );
            return { data: { info: { id: 'msg_assistant_1', role: 'assistant' }, parts: [] } };
          }
        }
      }
    };

    const previousDrainMs = process.env.OPENCODE_EVENT_DRAIN_IDLE_MS;
    const previousPollMs = process.env.OPENCODE_SESSION_STATUS_POLL_MS;
    process.env.OPENCODE_EVENT_DRAIN_IDLE_MS = '1';
    process.env.OPENCODE_SESSION_STATUS_POLL_MS = '1';
    try {
      const lines = await captureBridgeOutput(async () => {
        await sendMessage(
          'hello fake runtime',
          '',
          '/repo',
          'default',
          'opencode-default',
          '',
          [],
          { runtime }
        );
      });

      assert.equal(created, true);
      assert.equal(promptStarted, true);
      assert.deepEqual(promptBody.parts, [{ type: 'text', text: 'hello fake runtime' }]);
      assert.deepEqual(markerPayloads(lines, '[CONTENT_DELTA]'), ['Fake response']);
      assert.ok(lines.includes('[THREAD_ID] ses_fake'));
      assert.ok(lines.includes('[MESSAGE_START]'));
      assert.ok(lines.includes('[STREAM_START]'));
      assert.ok(lines.includes('[STREAM_END]'));
      assert.ok(lines.includes('[MESSAGE_END]'));
      assert.equal(lines.some((line) => line.startsWith('[SEND_ERROR]')), false);
    } finally {
      if (previousDrainMs === undefined) delete process.env.OPENCODE_EVENT_DRAIN_IDLE_MS;
      else process.env.OPENCODE_EVENT_DRAIN_IDLE_MS = previousDrainMs;
      if (previousPollMs === undefined) delete process.env.OPENCODE_SESSION_STATUS_POLL_MS;
      else process.env.OPENCODE_SESSION_STATUS_POLL_MS = previousPollMs;
    }
  });
});
