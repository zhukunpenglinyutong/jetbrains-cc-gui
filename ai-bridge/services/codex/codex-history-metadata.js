import { stat } from 'node:fs/promises';
import favoritesService from '../favorites-service.cjs';
import titlesService from '../session-titles-service.cjs';

function metadataBySessionId(records) {
  const direct = new Map();
  const legacy = new Map();
  if (!records || typeof records !== 'object' || Array.isArray(records)) return direct;
  for (const [key, value] of Object.entries(records)) {
    if (!key.trimStart().startsWith('{')) {
      direct.set(key, value);
      continue;
    }
    try {
      // Older plugin versions stored a JSON-encoded {sessionId, provider} as the key.
      const identity = JSON.parse(key);
      if (typeof identity?.sessionId === 'string' && (!identity.provider || identity.provider === 'codex')) {
        legacy.set(identity.sessionId, value);
      }
    } catch {
      // Invalid legacy keys cannot identify a session.
    }
  }
  return new Map([...legacy, ...direct]);
}

/** Adds plugin-owned metadata without changing native thread names or local JSON files. */
export function applyCodexHistoryMetadata(threads, favorites, titles) {
  const favoriteById = metadataBySessionId(favorites);
  const titleById = metadataBySessionId(titles);
  return (threads ?? []).map(thread => {
    if (!thread || typeof thread.id !== 'string') return thread;
    const favorite = favoriteById.get(thread.id);
    const isFavorited = !!favorite && typeof favorite === 'object' && !Array.isArray(favorite);
    const customTitle = titleById.get(thread.id)?.customTitle;
    const hasCustomTitle = typeof customTitle === 'string' && customTitle.trim().length > 0;
    return { ...thread, isFavorited,
      favoritedAt: isFavorited && Number.isFinite(favorite.favoritedAt) ? favorite.favoritedAt : undefined,
      hasCustomTitle, customTitle: hasCustomTitle ? customTitle : undefined };
  });
}

/** Read on every list/page request so edits survive reopening and changes in other IDE windows. */
export function enrichCodexHistoryThreads(threads, {
  loadFavorites = favoritesService.loadFavorites,
  loadTitles = titlesService.loadTitles,
} = {}) {
  return applyCodexHistoryMetadata(threads, loadFavorites(), loadTitles());
}

/** Fetch all saved IDs before normal paging, without resuming threads or loading their transcripts. */
export async function readFavoriteCodexThreads(readThread, { loadFavorites = favoritesService.loadFavorites } = {}) {
  const entries = [...metadataBySessionId(loadFavorites())]
    .filter(([id, favorite]) => /^[a-zA-Z0-9_-]{1,128}$/.test(id)
      && favorite && typeof favorite === 'object' && !Array.isArray(favorite))
    .sort((a, b) => (Number(b[1].favoritedAt) || 0) - (Number(a[1].favoritedAt) || 0));
  const threads = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++;
      const [id] = entries[index];
      try {
        const response = await readThread(id);
        if (response?.thread?.id === id) {
          const { turns, ...metadata } = response.thread;
          threads[index] = metadata;
        }
      } catch {
        // Favorites are shared with other providers and can refer to removed Codex rollouts.
      }
    }
  }));
  return threads.filter(Boolean);
}

/** Native thread/list can retain database rows after their rollout was deleted on disk. */
export async function filterAvailableCodexThreads(threads, { statFile = stat } = {}) {
  const available = [];
  for (let offset = 0; offset < threads.length; offset += 32) {
    const batch = threads.slice(offset, offset + 32);
    const exists = await Promise.all(batch.map(async thread => {
      // Ephemeral threads and older servers without a path have no file to check.
      if (thread?.ephemeral === true || typeof thread?.path !== 'string' || !thread.path) return true;
      try {
        await statFile(thread.path);
        return true;
      } catch (error) {
        // Permission or temporary I/O failures do not prove the session was removed.
        return error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR';
      }
    }));
    available.push(...batch.filter((_, index) => exists[index]));
  }
  return available;
}
