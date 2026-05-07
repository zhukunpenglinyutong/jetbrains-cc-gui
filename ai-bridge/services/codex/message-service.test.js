import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterCodexExperimentalJsonLines,
  isIgnorableCodexEventNoiseLine,
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
    isIgnorableCodexEventNoiseLine('成功: 已终止 PID 37392 (属于 PID 38456 子进程) 的进程。'),
    true,
  );
  assert.equal(
    isIgnorableCodexEventNoiseLine('成功: 已终止 PID 37392 的进程。'),
    true,
  );
  assert.equal(
    isIgnorableCodexEventNoiseLine('�ɹ�: ����ֹ PID 42484 (���� PID 47728 �ӽ���)�Ľ��̡�'),
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
