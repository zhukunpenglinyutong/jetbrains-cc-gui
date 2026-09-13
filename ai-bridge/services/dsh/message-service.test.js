import test from 'node:test';
import assert from 'node:assert/strict';

import { splitModelTuple } from './message-service.js';
import { buildPromptContent } from './session.js';

test('splitModelTuple splits "<provider>/<model>" tuples', () => {
  assert.deepEqual(splitModelTuple('openai/gpt-5'), { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(splitModelTuple('openrouter/a/b'), { provider: 'openrouter', model: 'a/b' });
});

test('splitModelTuple maps empty and sentinel values to host default', () => {
  assert.equal(splitModelTuple(''), null);
  assert.equal(splitModelTuple(null), null);
  assert.equal(splitModelTuple(undefined), null);
  assert.equal(splitModelTuple('   '), null);
  assert.equal(splitModelTuple('auto'), null);
  assert.equal(splitModelTuple('default'), null);
  assert.equal(splitModelTuple('dsh-default'), null);
});

test('splitModelTuple keeps a bare model with an empty provider', () => {
  assert.deepEqual(splitModelTuple('gpt-5'), { provider: '', model: 'gpt-5' });
  assert.deepEqual(splitModelTuple('provider/'), { provider: 'provider', model: '' });
});

test('buildPromptContent attaches image name only when non-empty', () => {
  // Host Zod is `name?: string` ($strip) — `name: null` is rejected.
  const content = buildPromptContent('hi', [
    { mediaType: 'image/jpeg', data: 'AAAA', name: 'shot.jpg' },
    { mediaType: 'image/png', data: 'BBBB', name: null },
    { mediaType: 'image/png', data: 'CCCC', name: '   ' },
  ]);
  assert.deepEqual(content[0], { type: 'text', text: 'hi' });
  assert.equal(content[1].name, 'shot.jpg');
  assert.ok(!('name' in content[2]), 'name: null must be stripped');
  assert.ok(!('name' in content[3]), 'blank name must be stripped');
});

test('buildPromptContent skips image parts without data and defaults mediaType', () => {
  const content = buildPromptContent('x', [
    { mediaType: 'image/png' },
    { data: 'AAAA' },
    null,
  ]);
  assert.equal(content.length, 2);
  assert.deepEqual(content[1], { type: 'image', mediaType: 'image/png', data: 'AAAA' });
});
