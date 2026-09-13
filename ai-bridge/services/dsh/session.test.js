import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionIdFromThread, threadIdForSession } from './session.js';

test('sessionIdFromThread strips the thread prefixes', () => {
  assert.equal(sessionIdFromThread('dsh:abc123'), 'abc123');
  assert.equal(sessionIdFromThread('dsh-pending-xyz'), 'xyz');
});

test('sessionIdFromThread passes through bare ids and trims', () => {
  assert.equal(sessionIdFromThread('abc123'), 'abc123');
  assert.equal(sessionIdFromThread('  dsh:abc  '), 'abc');
  assert.equal(sessionIdFromThread(''), '');
  assert.equal(sessionIdFromThread(null), '');
  assert.equal(sessionIdFromThread(undefined), '');
});

test('sessionIdFromThread only strips a leading prefix', () => {
  assert.equal(sessionIdFromThread('xxdsh:abc'), 'xxdsh:abc');
  assert.equal(sessionIdFromThread('dsh:dsh:abc'), 'dsh:abc');
});

test('threadIdForSession round-trips through sessionIdFromThread', () => {
  assert.equal(threadIdForSession('s1'), 'dsh:s1');
  assert.equal(sessionIdFromThread(threadIdForSession('s1')), 's1');
});
