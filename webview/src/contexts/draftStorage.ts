import { expandQuoteTokens } from '../components/ChatInputBox/utils/quoteRegistry';

/**
 * Text draft persistence for the chat input.
 *
 * Cache Storage is shared by JCEF's file-backed documents, so it survives browser recreation.
 * Its writes are asynchronous and do not finish once the document unloads, so every write is
 * also mirrored synchronously to sessionStorage, which survives a reload of the same browser.
 * Reads take the newer of the two snapshots.
 */
const DRAFT_CACHE_NAME = 'ccgui-drafts-v1';
const DRAFT_URL_PREFIX = 'https://cc-gui-webview.local/drafts/';
const DRAFT_SESSION_PREFIX = 'ccgui-draft:';
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DRAFT_MAX_ENTRIES = 32;

interface DraftSnapshot {
  text: string;
  savedAt: number;
}

let draftWrites: Promise<void> = Promise.resolve();

export function draftCacheKey(): string | null {
  return window.__CCGUI_DRAFT_CACHE_KEY__ || null;
}

function draftUrl(key: string): string {
  return `${DRAFT_URL_PREFIX}${encodeURIComponent(key)}`;
}

function toSnapshot(value: unknown, now: number): DraftSnapshot | null {
  const candidate = value as Partial<DraftSnapshot> | null;
  if (typeof candidate?.text !== 'string' || typeof candidate.savedAt !== 'number') return null;
  if (now - candidate.savedAt > DRAFT_MAX_AGE_MS) return null;
  return { text: candidate.text, savedAt: candidate.savedAt };
}

function readSessionSnapshot(key: string, now: number): DraftSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_SESSION_PREFIX + key);
    return raw ? toSnapshot(JSON.parse(raw), now) : null;
  } catch {
    return null;
  }
}

async function readCacheSnapshot(key: string, now: number): Promise<DraftSnapshot | null> {
  try {
    const cache = await caches.open(DRAFT_CACHE_NAME);
    const url = draftUrl(key);
    const response = await cache.match(url);
    if (!response) return null;
    const snapshot = toSnapshot(await response.json(), now);
    if (!snapshot) await cache.delete(url);
    return snapshot;
  } catch {
    // A denied or unavailable browser cache must not disable editing.
    return null;
  }
}

/** Resolves the newest unexpired draft for the current window; never rejects. */
export async function readDraft(): Promise<string> {
  const key = draftCacheKey();
  if (!key) return '';
  const now = Date.now();
  const session = readSessionSnapshot(key, now);
  const cached = await readCacheSnapshot(key, now);
  const newest = session && (!cached || session.savedAt >= cached.savedAt) ? session : cached;
  return newest?.text ?? '';
}

function storeSessionSnapshot(key: string, snapshot: DraftSnapshot): void {
  try {
    window.sessionStorage.setItem(DRAFT_SESSION_PREFIX + key, JSON.stringify(snapshot));
  } catch {
    // sessionStorage can be denied or full; Cache Storage remains the primary copy.
  }
}

/** Quote chips use an in-memory registry; persist their Markdown before the document disappears. */
function snapshotOf(text: string): DraftSnapshot {
  return { text: expandQuoteTokens(text), savedAt: Date.now() };
}

/**
 * Synchronously records the draft for a reload of this browser. An empty text is kept as a
 * tombstone so an older Cache Storage entry cannot reappear after a fast reload.
 */
export function mirrorDraft(text: string): void {
  const key = draftCacheKey();
  if (key) storeSessionSnapshot(key, snapshotOf(text));
}

/** Mirrors the draft synchronously and queues the Cache Storage copy used after recreation. */
export function writeDraft(text: string): Promise<void> {
  const key = draftCacheKey();
  if (!key) return draftWrites;
  const snapshot = snapshotOf(text);
  storeSessionSnapshot(key, snapshot);
  const url = draftUrl(key);
  draftWrites = draftWrites.then(async () => {
    const cache = await caches.open(DRAFT_CACHE_NAME);
    if (!snapshot.text) {
      await cache.delete(url);
      return;
    }
    await cache.put(url, new Response(JSON.stringify(snapshot), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, -DRAFT_MAX_ENTRIES).map((request) => cache.delete(request)));
  }).catch(() => {});
  return draftWrites;
}

/**
 * Window keys are not reused after a tab closes or the IDE restarts, so their drafts are never
 * read again. Drop every expired or unreadable entry, then keep only the newest entries.
 */
export function pruneDrafts(): Promise<void> {
  draftWrites = draftWrites.then(async () => {
    const cache = await caches.open(DRAFT_CACHE_NAME);
    const now = Date.now();
    const live: Array<{ request: Request; savedAt: number }> = [];
    for (const request of await cache.keys()) {
      let snapshot: DraftSnapshot | null = null;
      try {
        const response = await cache.match(request);
        snapshot = response ? toSnapshot(await response.json(), now) : null;
      } catch {
        snapshot = null;
      }
      if (snapshot) live.push({ request, savedAt: snapshot.savedAt });
      else await cache.delete(request);
    }
    const overflow = [...live]
      .sort((left, right) => right.savedAt - left.savedAt)
      .slice(DRAFT_MAX_ENTRIES);
    await Promise.all(overflow.map(({ request }) => cache.delete(request)));
  }).catch(() => {});
  return draftWrites;
}
