import test from 'node:test';
import assert from 'node:assert/strict';
import { listCommands, mapOmpCommands } from './commands-service.js';

test('strips leading slashes and keeps description, hint and source', () => {
  const commands = mapOmpCommands({
    commands: [
      { name: '/compact', source: 'builtin', description: 'Compact the session', input: { hint: '[focus]' } },
      { name: 'todo', source: 'builtin', description: 'Show todos' },
    ],
  });
  assert.deepEqual(commands, [
    { name: 'compact', description: 'Compact the session', argumentHint: '[focus]', source: 'builtin' },
    { name: 'todo', description: 'Show todos', argumentHint: '', source: 'builtin' },
  ]);
});

test('missing or mistyped fields fall back to empty strings', () => {
  const commands = mapOmpCommands({
    commands: [
      { name: 'bare' },
      { name: 'odd', description: 42, source: null, input: { hint: 7 } },
      { name: 'noinput', input: null },
    ],
  });
  assert.deepEqual(commands, [
    { name: 'bare', description: '', argumentHint: '', source: '' },
    { name: 'odd', description: '', argumentHint: '', source: '' },
    { name: 'noinput', description: '', argumentHint: '', source: '' },
  ]);
});

test('entries without a usable string name are skipped', () => {
  const commands = mapOmpCommands({
    commands: [null, 'compact', 5, {}, { name: 9 }, { name: '' }, { name: '/' }, { name: 'ok' }],
  });
  assert.deepEqual(commands.map((c) => c.name), ['ok']);
});

test('duplicates by name keep the first entry, including slash-prefixed twins', () => {
  const commands = mapOmpCommands({
    commands: [
      { name: 'session', description: 'first', source: 'builtin' },
      { name: '/session', description: 'second', source: 'skill' },
      { name: 'session', description: 'third' },
      { name: 'todo' },
    ],
  });
  assert.equal(commands.length, 2);
  assert.equal(commands[0].description, 'first');
  assert.equal(commands[0].source, 'builtin');
});

test('non-array or missing commands yield an empty list', () => {
  for (const data of [undefined, null, 'x', 3, [], {}, { commands: null }, { commands: 'compact' }, { commands: {} }]) {
    assert.deepEqual(mapOmpCommands(data), []);
  }
});

async function captureStdout(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

function fakeClient({ startError, requestResult, requestError, calls }) {
  return () => ({
    async start(options) {
      calls.push(['start', options]);
      if (startError) throw startError;
    },
    async request(frame, options) {
      calls.push(['request', frame, options]);
      if (requestError) throw requestError;
      return requestResult;
    },
    async close(options) {
      calls.push(['close', options]);
    },
  });
}

test('listCommands prints one success line and always closes the client', async () => {
  const calls = [];
  const lines = await captureStdout(() => listCommands(
    { cwd: process.cwd() },
    { createClient: fakeClient({ calls, requestResult: { commands: [{ name: '/compact', description: 'c' }] } }) },
  ));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    success: true,
    commands: [{ name: 'compact', description: 'c', argumentHint: '', source: '' }],
  });
  assert.deepEqual(calls.map((c) => c[0]), ['start', 'request', 'close']);
  assert.deepEqual(calls[1][1], { type: 'get_available_commands' });
});

test('listCommands reports a start failure as success:false and still closes', async () => {
  const calls = [];
  const lines = await captureStdout(() => listCommands(
    { cwd: process.cwd() },
    { createClient: fakeClient({ calls, startError: new Error('timed out waiting for ready') }) },
  ));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    success: false,
    error: 'timed out waiting for ready',
    commands: [],
  });
  assert.deepEqual(calls.map((c) => c[0]), ['start', 'close']);
});

test('listCommands reports a request failure and a missing binary without throwing', async () => {
  const calls = [];
  const lines = await captureStdout(async () => {
    await listCommands(
      { cwd: process.cwd() },
      { createClient: fakeClient({ calls, requestError: new Error('boom') }) },
    );
    const enoent = Object.assign(new Error('spawn omp ENOENT'), { code: 'ENOENT' });
    await listCommands(
      { cwd: process.cwd() },
      { createClient: fakeClient({ calls: [], startError: enoent }) },
    );
  });
  const [request, missing] = lines.map((line) => JSON.parse(line));
  assert.equal(request.success, false);
  assert.equal(request.error, 'boom');
  assert.deepEqual(request.commands, []);
  assert.equal(missing.success, false);
  assert.match(missing.error, /OMP CLI not found/);
  assert.deepEqual(missing.commands, []);
});

test('listCommands falls back to process.cwd() when cwd is empty', async () => {
  let seen;
  await captureStdout(() => listCommands({ cwd: '' }, {
    createClient: (options) => {
      seen = options;
      return {
        async start() {},
        async request() { return { commands: [] }; },
        async close() {},
      };
    },
  }));
  assert.equal(seen.cwd, process.cwd());
  assert.deepEqual(seen.args, ['--mode', 'rpc', '--no-ui', '--no-session']);
});
