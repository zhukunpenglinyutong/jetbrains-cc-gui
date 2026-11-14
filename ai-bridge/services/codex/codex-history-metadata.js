/** Normalize old JSON-encoded identities; current direct keys always win. */
export function normalizeCodexMetadataKeys(records) {
  const legacy = Object.create(null);
  const direct = Object.create(null);
  if (!records || typeof records !== 'object' || Array.isArray(records)) return {};
  for (const [key, value] of Object.entries(records)) {
    if (!key.trimStart().startsWith('{')) {
      if (!value?.provider || value.provider === 'codex') direct[key] = value;
      continue;
    }
    try {
      const identity = JSON.parse(key);
      if (typeof identity?.sessionId === 'string' && (!identity.provider || identity.provider === 'codex')) {
        legacy[identity.sessionId] = value;
      }
    } catch { /* Invalid keys cannot identify a session. */ }
  }
  return { ...legacy, ...direct };
}

export function applyCodexFavorites(threads, records) {
  const favorites = normalizeCodexMetadataKeys(records);
  return threads.map(thread => ({ ...thread,
    isFavorited: Object.hasOwn(favorites, thread.id) && !!favorites[thread.id] && typeof favorites[thread.id] === 'object' && !Array.isArray(favorites[thread.id]),
    favoritedAt: Number.isFinite(favorites[thread.id]?.favoritedAt) ? favorites[thread.id].favoritedAt : undefined,
  }));
}

const catalogs = new WeakMap();
export const MAX_FAVORITE_LOOKUP_PAGES = 10;

/** Resolve saved favorites from scoped list metadata, never one thread/read per saved ID. */
export async function readFavoriteCodexThreads({ owner, scope, firstPage, readPage, matchProject,
  favorites: records, now = Date.now() }) {
  const favorites = normalizeCodexMetadataKeys(records);
  const ids = new Set(Object.entries(favorites).filter(([, value]) => value && typeof value === 'object'
    && !Array.isArray(value)).map(([id]) => id));
  if (!ids.size) return [];
  const firstRows = firstPage.data ?? [];
  const selectFavorites = rows => matchProject(rows).filter(thread => ids.has(thread.id))
    .sort((a, b) => (favorites[b.id]?.favoritedAt ?? 0) - (favorites[a.id]?.favoritedAt ?? 0));
  const missing = new Set(ids);
  for (const row of firstRows) missing.delete(row.id);
  if (!missing.size) return selectFavorites(firstRows);
  let scopes = catalogs.get(owner);
  if (!scopes) { scopes = new Map(); catalogs.set(owner, scopes); }
  let catalog = scopes.get(scope);
  if (!catalog || now - catalog.loadedAt >= 30_000) {
    const rows = [...firstRows];
    const visited = new Set();
    let cursor = firstPage.nextCursor;
    try {
      // Shared favorites have no provider, so unknown IDs must never cause an unbounded walk.
      while (missing.size && cursor != null && !visited.has(cursor)
          && visited.size < MAX_FAVORITE_LOOKUP_PAGES) {
        visited.add(cursor);
        const page = await readPage(cursor);
        rows.push(...(page.data ?? []));
        for (const row of page.data ?? []) missing.delete(row.id);
        cursor = page.nextCursor;
      }
    } catch {
      // Supplemental metadata must not prevent the already loaded native page from opening.
      return selectFavorites(firstRows);
    }
    catalog = { loadedAt: now, rows: matchProject(rows) };
    if (scopes.size >= 8) scopes.clear();
    scopes.set(scope, catalog);
  }
  return selectFavorites([...new Map([...catalog.rows, ...firstRows].map(row => [row.id, row])).values()]);
}
