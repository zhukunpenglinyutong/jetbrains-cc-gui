import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeQuoteToken, registerQuote } from '../components/ChatInputBox/utils/quoteRegistry';
import {
  DRAFT_MAX_AGE_MS,
  DRAFT_MAX_ENTRIES,
  mirrorDraft,
  pruneDrafts,
  readDraft,
  writeDraft,
} from './draftStorage';

const CACHE_NAME = 'ccgui-drafts-v1';
const urlFor = (key: string) => `https://cc-gui-webview.local/drafts/${encodeURIComponent(key)}`;

/** Minimal in-memory Cache Storage that keeps insertion order like the spec. */
function installFakeCaches() {
  const stores = new Map<string, Map<string, string>>();
  const toUrl = (request: RequestInfo | URL) => (typeof request === 'string' ? request : String((request as Request).url ?? request));
  const open = vi.fn(async (name: string) => {
    const entries = stores.get(name) ?? new Map<string, string>();
    stores.set(name, entries);
    return {
      match: async (request: RequestInfo | URL) => {
        const body = entries.get(toUrl(request));
        return body === undefined ? undefined : new Response(body);
      },
      put: async (request: RequestInfo | URL, response: Response) => {
        const url = toUrl(request);
        entries.delete(url);
        entries.set(url, await response.text());
      },
      delete: async (request: RequestInfo | URL) => entries.delete(toUrl(request)),
      keys: async () => [...entries.keys()].map((url) => ({ url }) as Request),
    };
  });
  vi.stubGlobal('caches', { open });
  const entries = () => stores.get(CACHE_NAME) ?? new Map<string, string>();
  const seed = (key: string, text: string, savedAt: number) => {
    const store = stores.get(CACHE_NAME) ?? new Map<string, string>();
    stores.set(CACHE_NAME, store);
    store.set(urlFor(key), JSON.stringify({ text, savedAt }));
  };
  return { open, entries, seed };
}

describe('draftStorage', () => {
  let fake: ReturnType<typeof installFakeCaches>;

  beforeEach(() => {
    fake = installFakeCaches();
    window.sessionStorage.clear();
    window.__CCGUI_DRAFT_CACHE_KEY__ = 'project:window-a';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__CCGUI_DRAFT_CACHE_KEY__;
  });

  it('does nothing without a window key', async () => {
    delete window.__CCGUI_DRAFT_CACHE_KEY__;
    await writeDraft('ignored');
    expect(await readDraft()).toBe('');
    expect(fake.open).not.toHaveBeenCalled();
  });

  it('restores a written draft and stores quote chips as Markdown', async () => {
    const id = registerQuote('quoted line');
    await writeDraft(`before ${makeQuoteToken(id)} after`);
    window.sessionStorage.clear();

    const restored = await readDraft();
    expect(restored).toContain('> quoted line');
    expect(restored).not.toContain(makeQuoteToken(id));
  });

  it('keeps the latest text when a reload cuts the async cache write short', async () => {
    fake.seed('project:window-a', 'older cached text', Date.now() - 1000);
    mirrorDraft('typed just before reload');
    expect(await readDraft()).toBe('typed just before reload');
  });

  it('does not resurrect a cleared draft whose cache delete did not finish', async () => {
    fake.seed('project:window-a', 'sent message', Date.now() - 1000);
    mirrorDraft('');
    expect(await readDraft()).toBe('');
  });

  it('prefers a newer cache entry written by a replacement page', async () => {
    mirrorDraft('this tab, earlier');
    fake.seed('project:window-a', 'replacement page, later', Date.now() + 1000);
    expect(await readDraft()).toBe('replacement page, later');
  });

  it('ignores and deletes an expired draft for the current window', async () => {
    fake.seed('project:window-a', 'stale', Date.now() - DRAFT_MAX_AGE_MS - 1);
    expect(await readDraft()).toBe('');
    expect(fake.entries().has(urlFor('project:window-a'))).toBe(false);
  });

  it('prunes expired drafts of windows that will never be read again', async () => {
    const now = Date.now();
    fake.seed('project:closed-old', 'secret old draft', now - DRAFT_MAX_AGE_MS - 1);
    fake.seed('project:closed-recent', 'recent draft', now - 1000);
    fake.entries().set(urlFor('project:corrupt'), 'not json');

    await pruneDrafts();

    expect(fake.entries().has(urlFor('project:closed-old'))).toBe(false);
    expect(fake.entries().has(urlFor('project:corrupt'))).toBe(false);
    expect(fake.entries().has(urlFor('project:closed-recent'))).toBe(true);
  });

  it('caps stored drafts by age, keeping the newest entries', async () => {
    const now = Date.now();
    for (let index = 0; index < DRAFT_MAX_ENTRIES + 3; index++) {
      // Insert newest first so insertion order and age disagree.
      fake.seed(`project:w${index}`, `draft ${index}`, now - index * 1000);
    }

    await pruneDrafts();

    expect(fake.entries().size).toBe(DRAFT_MAX_ENTRIES);
    expect(fake.entries().has(urlFor('project:w0'))).toBe(true);
    expect(fake.entries().has(urlFor(`project:w${DRAFT_MAX_ENTRIES + 2}`))).toBe(false);
  });

  it('keeps working when browser storage is denied', async () => {
    vi.stubGlobal('caches', { open: vi.fn(() => Promise.reject(new DOMException('denied', 'SecurityError'))) });
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    await expect(writeDraft('still editable')).resolves.toBeUndefined();
    await expect(pruneDrafts()).resolves.toBeUndefined();
    expect(await readDraft()).toBe('');
  });
});
