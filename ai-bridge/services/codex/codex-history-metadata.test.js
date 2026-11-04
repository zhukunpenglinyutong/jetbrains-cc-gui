import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCodexMetadataKeys, applyCodexFavorites, readFavoriteCodexThreads, MAX_FAVORITE_LOOKUP_PAGES } from './codex-history-metadata.js';

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

const matchAll = rows => rows;
test('favorites already present on page one never trigger supplemental reads', async () => {
  const rows = [{ id: 'saved' }];
  const result = await readFavoriteCodexThreads({ owner: {}, scope: 'p',
    favorites: { saved: { favoritedAt: 1 } }, firstPage: { data: rows, nextCursor: 'next' },
    matchProject: matchAll, readPage: async () => { throw new Error('must not read'); } });
  assert.deepEqual(result, rows);
});

test('supplemental lookup stops immediately after finding all favorites', async () => {
  let calls = 0;
  const result = await readFavoriteCodexThreads({ owner: {}, scope: 'p',
    favorites: { saved: {} }, firstPage: { data: [], nextCursor: 'next' }, matchProject: matchAll,
    readPage: async () => { calls++; return { data: [{ id: 'saved' }], nextCursor: 'unnecessary' }; } });
  assert.equal(calls, 1);
  assert.deepEqual(result, [{ id: 'saved' }]);
});

test('unknown shared Claude favorites have a bounded native catalog lookup', async () => {
  let calls = 0;
  const result = await readFavoriteCodexThreads({ owner: {}, scope: 'p',
    favorites: { 'claude-only': {} }, firstPage: { data: [], nextCursor: 'start' }, matchProject: matchAll,
    readPage: async () => ({ data: [], nextCursor: String(++calls) }) });
  assert.equal(calls, MAX_FAVORITE_LOOKUP_PAGES);
  assert.deepEqual(result, []);
});

test('a later page failure returns only page one and does not cache a failed walk', async () => {
  const owner = {};
  let calls = 0;
  const data = { owner, scope: 'p', favorites: { first: {}, later: {}, missing: {} },
    firstPage: { data: [{ id: 'first' }], nextCursor: 'next' }, matchProject: matchAll,
    readPage: async cursor => {
      calls++;
      if (cursor === 'next') return { data: [{ id: 'later' }], nextCursor: 'failure' };
      throw new Error('app server unavailable');
    } };
  assert.deepEqual(await readFavoriteCodexThreads(data), [{ id: 'first' }]);
  assert.deepEqual(await readFavoriteCodexThreads(data), [{ id: 'first' }]);
  assert.equal(calls, 4);
});

test('repeated cursors terminate supplemental lookup', async () => {
  let calls = 0;
  await readFavoriteCodexThreads({ owner: {}, scope: 'p', favorites: { unknown: {} },
    firstPage: { data: [], nextCursor: 'same' }, matchProject: matchAll,
    readPage: async () => { calls++; return { data: [], nextCursor: 'same' }; } });
  assert.equal(calls, 1);
});
