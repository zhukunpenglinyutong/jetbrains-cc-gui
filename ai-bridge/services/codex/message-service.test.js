import test from 'node:test';
import assert from 'node:assert/strict';
import {
  abortCurrentCodexTurn,
  filterCodexExperimentalJsonLines,
  getCodexThreadCacheSizeForTest,
  invalidateCodexThreadCacheForSignature,
  isIgnorableCodexEventNoiseLine,
  resetCodexThreadCache,
} from './message-service.js';

async function collect(asyncIterable) {
  const items = [];
  for await (const item of asyncIterable) {
    items.push(item);
  }
  return items;
}

test('recognizes Windows process termination noise emitted after Codex runs', () => {
  assert.equal(
    isIgnorableCodexEventNoiseLine('SUCCESS: The process with PID 41032 (child process of PID 20716) has been terminated.'),
    true,
  );
  assert.equal(
    isIgnorableCodexEventNoiseLine('SUCCESS: The process with PID 41032 has been terminated.'),
    true,
  );
  assert.equal(
    isIgnorableCodexEventNoiseLine('{"type":"event_msg","payload":{"type":"user_message"}}'),
    false,
  );
});

test('filters Windows process termination noise without dropping valid Codex items', async () => {
  const noise = [];

  async function* source() {
    yield '{"type":"event_msg","payload":{"type":"user_message"}}';
    yield 'SUCCESS: The process with PID 41032 (child process of PID 20716) has been terminated.';
    yield '{"type":"response_item","payload":{"type":"message"}}';
  }

  const items = await collect(filterCodexExperimentalJsonLines(source(), (line) => noise.push(line)));

  assert.deepEqual(items, [
    '{"type":"event_msg","payload":{"type":"user_message"}}',
    '{"type":"response_item","payload":{"type":"message"}}',
  ]);
  assert.deepEqual(noise, [
    'SUCCESS: The process with PID 41032 (child process of PID 20716) has been terminated.',
  ]);
});

test('Codex thread cache reset helper clears cached entries state', () => {
  resetCodexThreadCache();
  assert.equal(getCodexThreadCacheSizeForTest(), 0);
  resetCodexThreadCache('non-existent-thread');
  assert.equal(getCodexThreadCacheSizeForTest(), 0);
});

test('Codex thread cache invalidation helper is a no-op for unknown signatures', () => {
  resetCodexThreadCache();
  invalidateCodexThreadCacheForSignature('missing-signature');
  assert.equal(getCodexThreadCacheSizeForTest(), 0);
});

test('Codex abort helper is a no-op when there is no active turn', async () => {
  assert.equal(await abortCurrentCodexTurn(), false);
});
