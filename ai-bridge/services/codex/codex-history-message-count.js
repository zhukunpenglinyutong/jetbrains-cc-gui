import { readNativeHistoryPage } from './codex-native-history.js';

/** Count the same native projections as history display without retaining transcript bodies. */
async function tallyNativeHistoryMessages(read, threadId) {
  const messageIds = new Set();
  const cursors = new Set();
  let anonymousMessages = 0;
  let cursor = null;
  let readMode = 'paged';
  do {
    const page = await readNativeHistoryPage(read, { threadId, cursor, limit: 100, readMode });
    for (const message of page.messages) {
      const id = message.raw?.uuid;
      if (id) messageIds.add(id);
      else anonymousMessages += 1;
    }
    readMode = page.readMode;
    cursor = page.cursor;
    if (cursor !== null && cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error('Native message count repeated its history cursor');
      cursors.add(cursor);
    } else if (!page.complete) {
      throw new Error('Native message count received incomplete history without a cursor');
    }
  } while (cursor !== null && cursor !== undefined);
  return messageIds.size + anonymousMessages;
}

/** Cache only counts on one runtime host; changed or active threads require fresh history. */
export function createNativeHistoryCounter(read, { cacheLimit = 128, cacheTtlMs = 60_000, timeoutMs = 110_000, now = Date.now } = {}) {
  const cache = new Map();
  return async (thread) => {
    if (typeof thread?.id !== 'string' || !thread.id) throw new Error('A native message count requires a thread id');
    const revision = JSON.stringify([thread.updatedAt, thread.path, thread.historyMode, thread.status]);
    const active = thread.status?.type === 'active';
    const cached = cache.get(thread.id);
    if (cached?.revision === revision && (cached.pending || !active && cached.expiresAt > now())) {
      cache.delete(thread.id);
      cache.set(thread.id, cached);
      return await cached.promise;
    }
    const entry = { revision, pending: true, expiresAt: 0, promise: null };
    let expired = false;
    let timer;
    const timeoutError = new Error('Native message count timed out');
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(timeoutError);
      }, timeoutMs);
    });
    // The Java request has a total budget; per-RPC timeouts alone allow a long traversal to outlive it.
    const tally = tallyNativeHistoryMessages(async (method, params) => {
      if (expired) throw timeoutError;
      const response = await read(method, params);
      if (expired) throw timeoutError;
      return response;
    }, thread.id);
    entry.promise = Promise.race([tally, deadline]).then((count) => {
      entry.pending = false;
      entry.expiresAt = now() + cacheTtlMs;
      return count;
    }).catch((error) => {
      // A failed read must be retried rather than remembered as an empty conversation.
      if (cache.get(thread.id) === entry) cache.delete(thread.id);
      throw error;
    }).finally(() => clearTimeout(timer));
    cache.set(thread.id, entry);
    if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    return await entry.promise;
  };
}
