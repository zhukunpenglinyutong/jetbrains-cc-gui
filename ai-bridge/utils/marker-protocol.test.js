import test from 'node:test';
import assert from 'node:assert/strict';
import { safePromptArg } from './marker-protocol.js';

test('guards a leading @ from pi/omp file argument parsing', () => {
  assert.equal(safePromptArg('@/abs/Foo.java#L1 pregunta'), ' @/abs/Foo.java#L1 pregunta');
});

test('preserves the existing leading dash guard', () => {
  assert.equal(safePromptArg('-algo'), ' -algo');
});

test('leaves ordinary text unchanged', () => {
  assert.equal(safePromptArg('texto normal'), 'texto normal');
});

test('normalizes nullish prompt values to an empty string', () => {
  assert.equal(safePromptArg(null), '');
  assert.equal(safePromptArg(undefined), '');
});
