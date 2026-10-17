import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildOpenCodeArgs,
  createOpenCodeEventDispatcher,
  parseOpenCodeEvent,
} from './message-service.js';

const SAMPLES_URL = new URL(
  '../../../docs/opencode/samples/opencode-1.18.32/',
  import.meta.url
);

/** Load a captured `opencode run --format json` sample as parsed event lines. */
function loadSampleLines(name) {
  const raw = readFileSync(new URL(`${name}.jsonl`, SAMPLES_URL), 'utf8');
  return raw.split('\n').filter((line) => line.trim());
}

test('buildOpenCodeArgs places prompt before -f so yargs does not swallow it', () => {
  const args = buildOpenCodeArgs({
    message: '这是什么',
    imagePaths: ['/tmp/cc-gui-cli-images/a.png'],
  });
  assert.deepEqual(args, [
    'run',
    '--format',
    'json',
    '--thinking',
    '这是什么',
    '-f',
    '/tmp/cc-gui-cli-images/a.png',
  ]);
  const promptIdx = args.indexOf('这是什么');
  const fileFlagIdx = args.indexOf('-f');
  assert.ok(promptIdx > 0);
  assert.ok(fileFlagIdx > promptIdx, 'prompt must precede -f');
});

test('buildOpenCodeArgs supports multiple images after prompt', () => {
  const args = buildOpenCodeArgs({
    message: 'describe both',
    model: 'provider/model',
    sessionId: 'ses_abc',
    imagePaths: ['/tmp/a.png', '/tmp/b.png'],
  });
  assert.deepEqual(args, [
    'run',
    '--format',
    'json',
    '--thinking',
    '--model',
    'provider/model',
    '--session',
    'ses_abc',
    'describe both',
    '-f',
    '/tmp/a.png',
    '-f',
    '/tmp/b.png',
  ]);
});

test('buildOpenCodeArgs without images keeps prompt as last positional', () => {
  const args = buildOpenCodeArgs({ message: 'hello' });
  assert.deepEqual(args, ['run', '--format', 'json', '--thinking', 'hello']);
});

test('buildOpenCodeArgs omits --thinking when thinking toggle is off', () => {
  const args = buildOpenCodeArgs({ message: 'hello', thinking: false });
  assert.deepEqual(args, ['run', '--format', 'json', 'hello']);
  assert.ok(!args.includes('--thinking'));
});

test('buildOpenCodeArgs maps bypassPermissions to --auto', () => {
  const args = buildOpenCodeArgs({ message: 'hello', autoApprove: true });
  assert.deepEqual(args, ['run', '--format', 'json', '--thinking', '--auto', 'hello']);
});

test('parseOpenCodeEvent classifies 1.18 part-typed events', () => {
  const [toolLine] = loadSampleLines('tool-call-turn').filter(
    (line) => JSON.parse(line).type === 'tool_use'
  );
  const toolEvent = parseOpenCodeEvent(toolLine);
  assert.equal(toolEvent.kind, 'tool');
  assert.equal(toolEvent.name, 'bash');
  assert.equal(toolEvent.id, 'call_2b401be8a6be4077ba939fae', 'callID wins over part.id');
  assert.equal(toolEvent.status, 'completed');
  assert.equal(toolEvent.content, 'hello-from-opencode\n');
  assert.equal(toolEvent.isError, false);
  assert.deepEqual(toolEvent.input, { command: 'echo hello-from-opencode' });

  const [reasoningLine] = loadSampleLines('thinking-turn-with-flag').filter(
    (line) => JSON.parse(line).type === 'reasoning'
  );
  const thought = parseOpenCodeEvent(reasoningLine);
  assert.equal(thought.kind, 'thought');
  assert.match(thought.data, /17\*23/);

  const textLine = loadSampleLines('long-text-turn').find(
    (line) => JSON.parse(line).type === 'text'
  );
  const text = parseOpenCodeEvent(textLine);
  assert.equal(text.kind, 'text');
  assert.ok(text.data.length > 500, 'full text arrives in a single part');
  assert.ok(text.partId, 'part id present for delta dedup');
});

test('parseOpenCodeEvent surfaces structured errors', () => {
  const errorLine = JSON.stringify({
    type: 'error',
    sessionID: 'ses_x',
    error: { name: 'APIError', data: { message: 'Upstream request failed' } },
  });
  const event = parseOpenCodeEvent(errorLine);
  assert.equal(event.kind, 'error');
  assert.equal(event.message, 'Upstream request failed');
});

function recordingSink() {
  const calls = [];
  return {
    calls,
    contentDelta: (text) => calls.push(['contentDelta', text]),
    thinkingDelta: (text) => calls.push(['thinkingDelta', text]),
    toolUse: (event) => calls.push(['toolUse', event]),
    toolResult: (event) => calls.push(['toolResult', event]),
    sendError: (message) => calls.push(['sendError', message]),
  };
}

test('dispatcher replays tool turn as paired tool_use + tool_result on one callID', () => {
  const sink = recordingSink();
  const dispatch = createOpenCodeEventDispatcher(sink);
  for (const line of loadSampleLines('tool-call-turn')) {
    dispatch(parseOpenCodeEvent(line));
  }

  const toolUses = sink.calls.filter(([type]) => type === 'toolUse');
  const toolResults = sink.calls.filter(([type]) => type === 'toolResult');
  assert.equal(toolUses.length, 1, 'exactly one tool_use card');
  assert.equal(toolResults.length, 1, 'exactly one paired tool_result');

  const [, use] = toolUses[0];
  const [, result] = toolResults[0];
  assert.equal(use.name, 'bash');
  assert.equal(use.id, result.toolUseId, 'pair shares the model-side callID');
  assert.equal(use.id, 'call_2b401be8a6be4077ba939fae');
  assert.deepEqual(use.input, { command: 'echo hello-from-opencode' });
  assert.equal(result.content, 'hello-from-opencode\n');
  assert.equal(result.isError, false);

  // Tool pair precedes the final text.
  const firstTextIdx = sink.calls.findIndex(([type]) => type === 'contentDelta');
  const toolResultIdx = sink.calls.findIndex(([type]) => type === 'toolResult');
  assert.ok(toolResultIdx < firstTextIdx, 'tool result arrives before the text step');
});

test('dispatcher replays thinking turn with thinking deltas', () => {
  const sink = recordingSink();
  const dispatch = createOpenCodeEventDispatcher(sink);
  for (const line of loadSampleLines('thinking-turn-with-flag')) {
    dispatch(parseOpenCodeEvent(line));
  }
  const thoughts = sink.calls.filter(([type]) => type === 'thinkingDelta');
  assert.equal(thoughts.length, 1);
  assert.match(thoughts[0][1], /391/);
});

test('dispatcher emits long text exactly once (no duplication on re-push)', () => {
  const sink = recordingSink();
  const dispatch = createOpenCodeEventDispatcher(sink);
  const lines = loadSampleLines('long-text-turn');
  for (const line of lines) {
    dispatch(parseOpenCodeEvent(line));
  }
  // Replay the same lines: a future version re-pushing cumulative parts must
  // not double the text.
  for (const line of lines) {
    dispatch(parseOpenCodeEvent(line));
  }
  const texts = sink.calls.filter(([type]) => type === 'contentDelta');
  assert.equal(texts.length, 1, 'same part id re-push emits nothing new');
  assert.ok(texts[0][1].length > 500);
});

test('dispatcher emits novel suffix for cumulative re-push of a part', () => {
  const sink = recordingSink();
  const dispatch = createOpenCodeEventDispatcher(sink);
  const partId = 'prt_x';
  dispatch({ kind: 'text', data: 'Hello', partId });
  dispatch({ kind: 'text', data: 'Hello, world', partId });
  const texts = sink.calls.filter(([type]) => type === 'contentDelta').map(([, text]) => text);
  assert.deepEqual(texts, ['Hello', ', world']);
});

test('dispatcher keeps legacy two-phase tool events working', () => {
  const sink = recordingSink();
  const dispatch = createOpenCodeEventDispatcher(sink);
  dispatch(parseOpenCodeEvent(JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_x',
    id: 'call_legacy_1',
    name: 'read',
    input: { file: '/a.txt' },
  })));
  dispatch(parseOpenCodeEvent(JSON.stringify({
    type: 'tool_result',
    sessionID: 'ses_x',
    tool_id: 'call_legacy_1',
    output: 'file contents',
  })));

  const toolUses = sink.calls.filter(([type]) => type === 'toolUse');
  const toolResults = sink.calls.filter(([type]) => type === 'toolResult');
  assert.equal(toolUses.length, 1);
  assert.equal(toolUses[0][1].name, 'read');
  assert.equal(toolResults[0][1].toolUseId, 'call_legacy_1');
});

test('dispatcher tolerates a slow tool (no intermediate events) as a clean pair', () => {
  const sink = recordingSink();
  const dispatch = createOpenCodeEventDispatcher(sink);
  for (const line of loadSampleLines('slow-tool-turn')) {
    dispatch(parseOpenCodeEvent(line));
  }
  const toolUses = sink.calls.filter(([type]) => type === 'toolUse');
  const toolResults = sink.calls.filter(([type]) => type === 'toolResult');
  assert.equal(toolUses.length, 1);
  assert.equal(toolResults.length, 1);
  assert.equal(toolUses[0][1].id, toolResults[0][1].toolUseId);
});
