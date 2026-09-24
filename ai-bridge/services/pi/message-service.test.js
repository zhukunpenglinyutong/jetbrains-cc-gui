import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPiArgs } from './message-service.js';

test('buildPiArgs resumes the exact session via --session <id>', () => {
  const args = buildPiArgs({ message: 'next turn', sessionId: 'abc-123' });
  assert.deepEqual(args, [
    '--print',
    '--mode',
    'json',
    '--session',
    'abc-123',
    'next turn',
  ]);
});

test('buildPiArgs trims surrounding whitespace from sessionId', () => {
  const args = buildPiArgs({ message: 'hi', sessionId: '  abc-123  ' });
  assert.deepEqual(args, ['--print', '--mode', 'json', '--session', 'abc-123', 'hi']);
});

test('buildPiArgs omits session flag for empty or unsafe sessionId', () => {
  for (const sessionId of ['', '   ', '.', '..', '../other', 'a/b', 'a\\b']) {
    const args = buildPiArgs({ message: 'hi', sessionId });
    assert.deepEqual(args, ['--print', '--mode', 'json', 'hi'], `sessionId=${sessionId}`);
  }
});

test('buildPiArgs keeps prompt as last positional after all flags', () => {
  const args = buildPiArgs({
    message: 'describe this',
    sessionId: 'abc-123',
    model: 'openai/gpt-5',
    reasoningEffort: 'high',
  });
  assert.deepEqual(args, [
    '--print',
    '--mode',
    'json',
    '--model',
    'openai/gpt-5',
    '--session',
    'abc-123',
    '--thinking',
    'high',
    'describe this',
  ]);
});

test('buildPiArgs drops default model aliases and unknown thinking levels', () => {
  const args = buildPiArgs({
    message: 'hi',
    model: 'auto',
    reasoningEffort: 'ludicrous',
  });
  assert.deepEqual(args, ['--print', '--mode', 'json', 'hi']);
});
