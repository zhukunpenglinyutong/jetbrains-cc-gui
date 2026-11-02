import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCodexMetadataKeys, applyCodexFavorites, readFavoriteCodexThreads } from './codex-history-metadata.js';

test('legacy keys work and direct Codex metadata wins without importing Claude identities', () => {
  const records = { [JSON.stringify({ sessionId: 'a', provider: 'codex' })]: { customTitle: 'Old' },
    a: { customTitle: 'New' }, [JSON.stringify({ sessionId: 'b', provider: 'claude' })]: {},
    foreign: { provider: 'claude' } };
  assert.deepEqual(normalizeCodexMetadataKeys(records), { a: { customTitle: 'New' } });
  assert.deepEqual(applyCodexFavorites([{ id: 'a' }], { a: { favoritedAt: 12 } }),
    [{ id: 'a', isFavorited: true, favoritedAt: 12 }]);
});

test('favorite lookup uses cached scoped list pages and never reads foreign individual threads', async () => {
  const owner = {};
  const favorites = { saved: { favoritedAt: 1 }, 'claude-only': { favoritedAt: 2 }, outside: { favoritedAt: 3 } };
  let calls = 0;
  const data = { owner, scope: 'project', favorites, firstPage: { data: [{ id: 'ordinary', cwd: '/project' }], nextCursor: 'next' },
    readPage: async cursor => {
      calls++; assert.equal(cursor, 'next');
      return { data: [{ id: 'saved', cwd: '/project' }, { id: 'outside', cwd: '/other' }], nextCursor: null };
    }, matchProject: rows => rows.filter(row => row.cwd === '/project'), now: 0 };
  assert.deepEqual((await readFavoriteCodexThreads(data)).map(row => row.id), ['saved']);
  assert.deepEqual((await readFavoriteCodexThreads({ ...data, now: 1000 })).map(row => row.id), ['saved']);
  assert.equal(calls, 1);
  await readFavoriteCodexThreads({ ...data, now: 30_001 });
  assert.equal(calls, 2);
});
