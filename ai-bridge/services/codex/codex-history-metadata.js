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

/** Resolve saved favorites from scoped list metadata, never one thread/read per saved ID. */
export async function readFavoriteCodexThreads({ owner, scope, firstPage, readPage, matchProject,
  favorites: records, now = Date.now() }) {
  const favorites = normalizeCodexMetadataKeys(records);
  const ids = new Set(Object.entries(favorites).filter(([, value]) => value && typeof value === 'object'
    && !Array.isArray(value)).map(([id]) => id));
  if (!ids.size) return [];
  let scopes = catalogs.get(owner);
  if (!scopes) { scopes = new Map(); catalogs.set(owner, scopes); }
  let catalog = scopes.get(scope);
  if (!catalog || now - catalog.loadedAt >= 30_000) {
    const rows = [...(firstPage.data ?? [])];
    const visited = new Set();
    let cursor = firstPage.nextCursor;
    while (cursor != null && !visited.has(cursor)) {
      visited.add(cursor);
      const page = await readPage(cursor);
      rows.push(...(page.data ?? []));
      cursor = page.nextCursor;
    }
    catalog = { loadedAt: now, rows: matchProject(rows) };
    if (scopes.size >= 8) scopes.clear();
    scopes.set(scope, catalog);
  }
  return catalog.rows.filter(thread => ids.has(thread.id))
    .sort((a, b) => (favorites[b.id]?.favoritedAt ?? 0) - (favorites[a.id]?.favoritedAt ?? 0));
}
