import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCodexHistoryMetadata, enrichCodexHistoryThreads, readFavoriteCodexThreads, filterAvailableCodexThreads } from './codex-history-metadata.js';

test('restores favorites and custom titles without modifying native metadata', () => {
  const native = Object.freeze({ id: 'saved', name: 'Native name', title: 'Native prompt' });
  const titles = Object.freeze({ saved: Object.freeze({ customTitle: 'My title', updatedAt: 20 }) });
  const favorites = Object.freeze({ saved: Object.freeze({ favoritedAt: 10 }) });
  const [row] = applyCodexHistoryMetadata([native], favorites, titles);
  assert.equal(row.customTitle, 'My title');
  assert.equal(row.hasCustomTitle, true);
  assert.equal(row.isFavorited, true);
  assert.equal(row.favoritedAt, 10);
  assert.equal(row.name, 'Native name');
  assert.equal(row.title, 'Native prompt');
  assert.equal(native.customTitle, undefined);
});

test('reads old JSON-encoded Codex keys and prefers direct session keys', () => {
  const titles = {
    [JSON.stringify({ sessionId: 'legacy', provider: 'codex' })]: { customTitle: 'Recovered old title' },
    [JSON.stringify({ sessionId: 'direct', provider: 'codex' })]: { customTitle: 'Old duplicate' },
    direct: { customTitle: 'Latest explicit title' },
    [JSON.stringify({ sessionId: 'foreign', provider: 'claude' })]: { customTitle: 'Foreign title' },
  };
  const rows = applyCodexHistoryMetadata([{ id: 'legacy' }, { id: 'direct' }, { id: 'foreign' }], {}, titles);
  assert.deepEqual(rows.map(row => row.customTitle), ['Recovered old title', 'Latest explicit title', undefined]);
  assert.equal(rows[2].hasCustomTitle, false);
});

test('reloads metadata each time so rename and unfavorite changes survive another list request', () => {
  let titles = { saved: { customTitle: 'First' } };
  let favorites = { saved: { favoritedAt: 10 } };
  const dependencies = { loadFavorites: () => favorites, loadTitles: () => titles };
  const native = [{ id: 'saved', name: 'Native' }];
  assert.equal(enrichCodexHistoryThreads(native, dependencies)[0].customTitle, 'First');
  titles = { saved: { customTitle: 'Renamed' } };
  favorites = {};
  const [row] = enrichCodexHistoryThreads(native, dependencies);
  assert.equal(row.customTitle, 'Renamed');
  assert.equal(row.isFavorited, false);
  assert.equal(row.favoritedAt, undefined);
});

test('missing or invalid metadata retains native titles and does not invent favorites', () => {
  for (const metadata of [undefined, null, [], 'invalid']) {
    const [row] = applyCodexHistoryMetadata([{ id: 'native', name: 'Native name' }], metadata, metadata);
    assert.equal(row.name, 'Native name');
    assert.equal(row.isFavorited, false);
    assert.equal(row.hasCustomTitle, false);
  }
  const [row] = applyCodexHistoryMetadata([{ id: 'native' }], { native: { favoritedAt: 'bad' } },
    { native: { customTitle: '   ' }, '{invalid': { customTitle: 'ignored' } });
  assert.equal(row.favoritedAt, undefined);
  assert.equal(row.hasCustomTitle, false);
});

test('favorite lookup visits every saved ID with bounded concurrency and keeps favorite order', async () => {
  const favorites = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`fav-${index}`, { favoritedAt: index }]));
  const visited = [];
  let active = 0;
  let maximum = 0;
  const rows = await readFavoriteCodexThreads(async id => {
    visited.push(id);
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return { thread: { id, cwd: '/project', turns: [{ secret: 'transcript is not list metadata' }] } };
  }, { loadFavorites: () => favorites });
  assert.equal(visited.length, 12);
  assert.ok(maximum <= 4);
  assert.deepEqual(rows.map(row => row.id), Array.from({ length: 12 }, (_, i) => `fav-${11 - i}`));
  assert.ok(rows.every(row => !Object.hasOwn(row, 'turns')));
});

test('favorite lookup skips stale, foreign and invalid IDs without hiding later matches', async () => {
  const favorites = { missing: {}, wrong: {}, saved: {}, '../invalid': {},
    [JSON.stringify({ sessionId: 'legacy', provider: 'codex' })]: {},
    [JSON.stringify({ sessionId: 'claude-only', provider: 'claude' })]: {} };
  const visited = [];
  const rows = await readFavoriteCodexThreads(async id => {
    visited.push(id);
    if (id === 'missing') throw new Error('Thread not found');
    return { thread: { id: id === 'wrong' ? 'unrelated' : id } };
  }, { loadFavorites: () => favorites });
  assert.deepEqual(rows.map(row => row.id).sort(), ['legacy', 'saved']);
  assert.equal(visited.includes('../invalid'), false);
  assert.equal(visited.includes('claude-only'), false);
  assert.deepEqual(await readFavoriteCodexThreads(() => { throw new Error('Unexpected lookup'); },
    { loadFavorites: () => ({}) }), []);
});

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
