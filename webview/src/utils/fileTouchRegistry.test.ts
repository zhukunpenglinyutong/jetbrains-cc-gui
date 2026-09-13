import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearFileTouchRegistry,
  getDistinctActorsForPath,
  isMultiActorPath,
  loadFileTouchMap,
  recordFileTouches,
  wasTouchedOutsideSession,
} from './fileTouchRegistry';

describe('fileTouchRegistry', () => {
  const store = new Map<string, string>();
  const STORAGE_KEY = 'ccgui-file-touch-registry-v1';

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records touches from two sessions on the same file as multi-actor', () => {
    const path = '/proj/name.js';
    const now = Date.now();
    recordFileTouches([path], 'AI1', new Map([[path, ['main']]]), now);
    recordFileTouches([path], 'AI2', new Map([[path, ['main']]]), now + 1);

    expect(isMultiActorPath(path)).toBe(true);
    expect(getDistinctActorsForPath(path)).toHaveLength(2);
    expect(wasTouchedOutsideSession(path, 'AI2')).toBe(true);
    expect(wasTouchedOutsideSession(path, 'AI1')).toBe(true);
  });

  it('two agents in one session are multi-actor', () => {
    const path = '/proj/x.ts';
    recordFileTouches([path], 'sess', new Map([[path, ['main', 'task-a']]]), Date.now());
    expect(isMultiActorPath(path)).toBe(true);
  });

  it('single session single agent is not multi-actor', () => {
    const path = '/proj/y.ts';
    const now = Date.now();
    recordFileTouches([path], 'sess', new Map([[path, ['main']]]), now);
    recordFileTouches([path], 'sess', new Map([[path, ['main']]]), now + 1);
    expect(isMultiActorPath(path)).toBe(false);
    expect(wasTouchedOutsideSession(path, 'sess')).toBe(false);
  });

  it('clear empties registry', () => {
    recordFileTouches(['/a'], 's', new Map([['/a', ['main']]]));
    expect(Object.keys(loadFileTouchMap()).length).toBeGreaterThan(0);
    clearFileTouchRegistry();
    expect(loadFileTouchMap()).toEqual({});
  });

  it('expires entries older than 24h on read (lazy TTL)', () => {
    const path = '/proj/old.ts';
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    recordFileTouches([path], 'AI1', new Map([[path, ['main']]]), stale);
    // Stale actor is pruned on next load, so a fresh session sees no prior touch
    recordFileTouches([path], 'AI2', new Map([[path, ['main']]]), Date.now());

    expect(isMultiActorPath(path)).toBe(false);
    expect(wasTouchedOutsideSession(path, 'AI2')).toBe(false);
    expect(getDistinctActorsForPath(path).map((a) => a.sessionId)).toEqual(['AI2']);
  });

  it('drops files whose actors all expired and persists the cleanup', () => {
    const path = '/proj/stale-only.ts';
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    recordFileTouches([path], 'AI1', new Map([[path, ['main']]]), stale);

    expect(loadFileTouchMap()).toEqual({});
    expect(store.get(STORAGE_KEY)).toBe('{}');
  });

  it('caps actors per file at 12, keeping the newest', () => {
    const path = '/proj/many-actors.ts';
    const now = Date.now();
    for (let i = 0; i < 13; i += 1) {
      recordFileTouches([path], `sess-${i}`, new Map([[path, ['main']]]), now + i);
    }

    const actors = getDistinctActorsForPath(path);
    expect(actors).toHaveLength(12);
    expect(actors.some((a) => a.sessionId === 'sess-12')).toBe(true);
    expect(actors.some((a) => a.sessionId === 'sess-0')).toBe(false);
  });

  it('caps total files at 400, dropping the oldest', () => {
    const now = Date.now();
    for (let i = 0; i < 405; i += 1) {
      const p = `/proj/f${i}.ts`;
      recordFileTouches([p], 'sess', new Map([[p, ['main']]]), now + i);
    }

    const map = loadFileTouchMap();
    expect(Object.keys(map)).toHaveLength(400);
    expect(map['/proj/f404.ts']).toBeDefined();
    expect(map['/proj/f0.ts']).toBeUndefined();
  });

  it('tolerates corrupted JSON in storage', () => {
    store.set(STORAGE_KEY, 'not-json{');
    expect(loadFileTouchMap()).toEqual({});

    store.set(STORAGE_KEY, '"a string"');
    expect(loadFileTouchMap()).toEqual({});

    store.set(STORAGE_KEY, '[1,2,3]');
    expect(loadFileTouchMap()).toEqual({});
  });
});
