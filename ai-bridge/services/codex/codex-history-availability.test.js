import assert from 'node:assert/strict';
import test from 'node:test';
import { filterAvailableCodexThreads } from './codex-history-availability.js';

test('only confirmed missing rollout files are hidden, including stale favorites', async () => {
  const threads = [
    { id: 'exists', path: '/exists' }, { id: 'missing', path: '/missing', isFavorited: true },
    { id: 'not-directory', path: '/not-directory' }, { id: 'denied', path: '/denied' },
    { id: 'legacy' }, { id: 'ephemeral', path: '/missing', ephemeral: true },
  ];
  const calls = [];
  const available = await filterAvailableCodexThreads(threads, { statFile: async path => {
    calls.push(path);
    if (path === '/exists') return {};
    throw Object.assign(new Error('filesystem error'), {
      code: path === '/missing' ? 'ENOENT' : path === '/not-directory' ? 'ENOTDIR' : 'EACCES',
    });
  } });
  assert.deepEqual(available.map(thread => thread.id), ['exists', 'denied', 'legacy', 'ephemeral']);
  assert.equal(calls.length, 4);
});
