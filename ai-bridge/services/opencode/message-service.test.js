import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCodeArgs } from './message-service.js';

test('buildOpenCodeArgs places prompt before -f so yargs does not swallow it', () => {
  const args = buildOpenCodeArgs({
    message: '这是什么',
    imagePaths: ['/tmp/cc-gui-cli-images/a.png'],
  });
  assert.deepEqual(args, [
    'run',
    '--format',
    'json',
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
  assert.deepEqual(args, ['run', '--format', 'json', 'hello']);
});
