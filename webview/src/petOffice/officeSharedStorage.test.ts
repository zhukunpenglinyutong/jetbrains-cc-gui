import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { OfficeNativeStorage, OfficeSharedPreferencesController, OfficeStorageError, parseOfficeSharedState } from './officeSharedStorage';
import type { OfficeSharedState } from './officeSharedStorage';
import type { sendOfficeRequest } from './officeBridge';
import { OFFICE_THEME_IDS } from './officeThemes';
import { OFFICE_MAX_FLOORS } from './officeModel';

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function state(revision = 'initial'): OfficeSharedState {
  return { schemaVersion: 1, revision, preferences: { officeName: '', limitMiB: 50, floors: Array.from({ length: OFFICE_MAX_FLOORS }, () => OFFICE_THEME_IDS[0]),
    floor: 0, product: 'all', search: '', showIdle: false, paused: false, topmost: true, zoom: 100, presentation: { effects: true, attention: true, ambience: true, depth: false }, appearanceOverrides: {} },
  bounds: { x: 0, y: 0, width: 1240, height: 900, placed: false } };
}
function id(index: number): string { return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`; }
function native() {
  const sent: Array<{ operation: string; requestId: string; payload: Record<string, unknown> }> = [];
  const send: typeof sendOfficeRequest = (_command, fields) => {
    if (typeof fields?.operation !== 'string' || typeof fields.requestId !== 'string' || typeof fields.payload !== 'string') throw new Error('Invalid test request');
    sent.push({ operation: fields.operation, requestId: fields.requestId, payload: JSON.parse(fields.payload) as Record<string, unknown> });
  };
  const storage = new OfficeNativeStorage('current-page', send);
  const reply = (index: number, type: string, fields: Record<string, unknown> = {}, pageGeneration = 'current-page') =>
    window.petOfficeStorageResult?.({ requestId: sent[index].requestId, pageGeneration, type, ...fields });
  return { storage, sent, reply };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete window.petOfficeStorageResult; });

describe('shared native Office storage', () => {
  it('restores legacy names and rejects malformed names without losing other preferences', () => {
    const original = state(), { officeName: _ignored, ...legacy } = original.preferences;
    expect(parseOfficeSharedState({ ...original, preferences: legacy })).toEqual(original);
    const named = { ...original, preferences: { ...original.preferences, officeName: '研发办公室 🐾 <team>' } };
    expect(parseOfficeSharedState(named)).toEqual(named);
    for (const officeName of [null, 100, {}, 'x'.repeat(65), 'line\nbreak', 'control\u0085']) {
      expect(() => parseOfficeSharedState({ ...original, preferences: { ...original.preferences, officeName } })).toThrow();
    }
  });

  it('migrates legacy preferences to inheritance and preserves binding-scoped choices', () => {
    const original = state(), { appearanceOverrides: _ignored, ...legacy } = original.preferences;
    expect(parseOfficeSharedState({ ...original, preferences: legacy }).preferences.appearanceOverrides).toEqual({});
    const changed = { ...original, preferences: { ...original.preferences, appearanceOverrides: { 'ide/tab/old': 'duck/spritesheet.png', 'ide/tab/new': 'builtin' } } };
    expect(parseOfficeSharedState(changed)).toEqual(changed);
    expect(() => parseOfficeSharedState({ ...original, preferences: { ...original.preferences, appearanceOverrides: { 'ide/tab/old': '../private.png' } } })).toThrow();
  });

  it('rejects malformed preferences and keeps exact bounds and per-floor settings', () => {
    expect(parseOfficeSharedState(state())).toEqual(state());
    for (const value of [{ ...state(), schemaVersion: 99 }, { ...state(), unexpected: true },
      { ...state(), preferences: { ...state().preferences, limitMiB: 15 } },
      { ...state(), preferences: { ...state().preferences, floors: [] } },
      { ...state(), preferences: { ...state().preferences, floors: Array(23).fill('loft') } },
      { ...state(), preferences: { ...state().preferences, floor: 22 } }]) expect(() => parseOfficeSharedState(value)).toThrow();
  });

  it('migrates legacy shared floor settings and accepts the last reachable floor', () => {
    const legacy = state(); legacy.preferences.floors = Array.from({ length: 16 }, () => 'forest'); legacy.preferences.floor = 15;
    const restored = parseOfficeSharedState(legacy);
    expect(restored.preferences.floors.slice(0, 16)).toEqual(legacy.preferences.floors);
    expect(restored.preferences.floors.slice(16)).toEqual(Array(6).fill('loft'));
    restored.preferences.floor = 21; restored.preferences.floors[21] = 'ocean';
    expect(parseOfficeSharedState(restored)).toEqual(restored);
  });

  it('fences old pages, bounds pending requests, and releases all promises on disposal', async () => {
    const h = native();
    const a = h.storage.request('backgroundRemove', { floor: 0 }), b = h.storage.request('backgroundRemove', { floor: 1 });
    const closed = expect(b).rejects.toThrow('OFFICE_STORAGE_CLOSED');
    await expect(h.storage.request('backgroundRead', { floor: 2 })).rejects.toThrow('OFFICE_STORAGE_BUSY');
    let finished = false; void a.then(() => { finished = true; });
    h.reply(0, 'value', {}, 'old-page'); await settle(); expect(finished).toBe(false);
    h.reply(0, 'value'); await a; h.storage.dispose(); await closed;
    expect(window.petOfficeStorageResult).toBeUndefined();
  });

  it('expires silent requests and rejects malformed, reordered, and duplicate chunks', async () => {
    vi.useFakeTimers(); const h = native();
    const pending = expect(h.storage.request('backgroundRead', { floor: 0 })).rejects.toThrow('OFFICE_STORAGE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(15000); await pending;
    const read = expect(h.storage.read(0)).rejects.toThrow('backgroundStorageError');
    h.reply(1, 'begin', { byteLength: 2, mime: 'image/png', digest: 'a'.repeat(64) });
    h.reply(1, 'chunk', { index: 1, data: btoa('ab') }); await read;
    const extra = expect(h.storage.read(0)).rejects.toThrow('backgroundStorageError');
    h.reply(2, 'value', { empty: true, path: 'C:/unexpected' }); await extra; h.storage.dispose();
  });

  it('validates complete chunk digests before exposing a background file', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    const h = native(), read = h.storage.read(0);
    h.reply(0, 'begin', { byteLength: 3, mime: 'image/png', digest });
    h.reply(0, 'chunk', { index: 0, data: btoa('\x01\x02\x03') }); h.reply(0, 'commit');
    const result = await read; expect(result?.type).toBe('image/png'); expect(result?.size).toBe(3);
    const invalid = expect(h.storage.read(1)).rejects.toThrow('backgroundStorageError');
    h.reply(1, 'begin', { byteLength: 3, mime: 'image/png', digest: '0'.repeat(64) });
    h.reply(1, 'chunk', { index: 0, data: btoa('\x01\x02\x03') }); h.reply(1, 'commit'); await invalid; h.storage.dispose();
  });
});

describe('revision-checked Office preferences', () => {
  it('treats native map ordering as equivalent and avoids redundant writes or choice rollback', async () => {
    const ordered = { 'ide/a/binding': 'red.png', 'ide/b/binding': 'blue.png' };
    const reversed = { 'ide/b/binding': 'blue.png', 'ide/a/binding': 'red.png' };
    const request = vi.fn(async () => ({ ...state(id(1)), preferences: { ...state().preferences, appearanceOverrides: reversed } }));
    const changed = vi.fn(), controller = new OfficeSharedPreferencesController(state(), { request }, changed);
    controller.save({ ...state().preferences, appearanceOverrides: ordered }); await controller.flushPending();
    expect(changed.mock.calls.at(-1)?.[2]).toBe(false);
    controller.save({ ...state().preferences, appearanceOverrides: reversed }); await controller.flushPending();
    expect(request).toHaveBeenCalledTimes(1); controller.dispose();
  });

  it('flushes a pending debounce before closing and waits for the storage acknowledgement', async () => {
    vi.useFakeTimers(); let finish: ((value: unknown) => void) | undefined;
    const request = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve; }));
    const controller = new OfficeSharedPreferencesController(state(), { request }, vi.fn());
    controller.save({ ...state().preferences, zoom: 125 });
    let complete = false; const closing = controller.flushPending().then(() => { complete = true; });
    expect(request).toHaveBeenCalledOnce(); await settle(); expect(complete).toBe(false);
    finish?.({ ...state(id(1)), preferences: { ...state().preferences, zoom: 125 } }); await closing;
    expect(complete).toBe(true); await vi.advanceTimersByTimeAsync(300); expect(request).toHaveBeenCalledOnce(); controller.dispose();
  });
  it('coalesces transient edits and keeps newer edits made while a save is in flight', async () => {
    vi.useFakeTimers();
    const completions: Array<(value: unknown) => void> = [];
    const request = vi.fn(() => new Promise<unknown>(resolve => { completions.push(resolve); }));
    const changed = vi.fn(), controller = new OfficeSharedPreferencesController(state(), { request }, changed);
    controller.save({ ...state().preferences, search: 'a' }); controller.save({ ...state().preferences, search: 'ab' });
    await vi.advanceTimersByTimeAsync(300); expect(request).toHaveBeenCalledTimes(1);
    controller.save({ ...state().preferences, search: 'abc' }); await vi.advanceTimersByTimeAsync(300);
    completions[0]({ ...state(id(1)), preferences: { ...state().preferences, search: 'ab' } }); await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]).toEqual(['preferences', { expectedRevision: id(1), preferences: { ...state().preferences, search: 'abc' } }]);
    completions[1]({ ...state(id(2)), preferences: { ...state().preferences, search: 'abc' } }); await settle();
    expect(changed.mock.calls.at(-1)?.[0].preferences.search).toBe('abc'); controller.dispose();
  });

  it('rebases a bounds-only conflict once and ignores already seen stale acknowledgements', async () => {
    vi.useFakeTimers(); const authoritative = { ...state(id(1)), bounds: { ...state().bounds, x: -1200, placed: true } };
    const request = vi.fn().mockRejectedValueOnce(new OfficeStorageError('OFFICE_PREFERENCES_CONFLICT', authoritative))
      .mockResolvedValueOnce({ ...authoritative, revision: id(2), preferences: { ...state().preferences, limitMiB: 96 } });
    const changed = vi.fn(), controller = new OfficeSharedPreferencesController(state(), { request }, changed);
    controller.save({ ...state().preferences, limitMiB: 96 }); await vi.advanceTimersByTimeAsync(300); await settle();
    expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls[1][1].expectedRevision).toBe(id(1));
    const count = changed.mock.calls.length; controller.adopt(state()); expect(changed).toHaveBeenCalledTimes(count); controller.dispose();
  });

  it('reverts a real preference conflict and safely rejects malformed conflict state', async () => {
    vi.useFakeTimers();
    for (const authoritative of [{ ...state(id(1)), preferences: { ...state().preferences, topmost: false } }, { schemaVersion: 99 }]) {
      const request = vi.fn().mockRejectedValue(new OfficeStorageError('OFFICE_PREFERENCES_CONFLICT', authoritative));
      const changed = vi.fn(), controller = new OfficeSharedPreferencesController(state(), { request }, changed);
      controller.save({ ...state().preferences, limitMiB: 64 }); await vi.advanceTimersByTimeAsync(300); await settle();
      expect(request).toHaveBeenCalledOnce(); expect(changed.mock.calls.at(-1)?.slice(1)).toEqual([true, true]); controller.dispose();
    }
  });

  it('does not save or apply late responses after disposal', async () => {
    vi.useFakeTimers(); let finish: ((value: unknown) => void) | undefined;
    const request = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve; }));
    const changed = vi.fn(), controller = new OfficeSharedPreferencesController(state(), { request }, changed);
    controller.save({ ...state().preferences, zoom: 125 }); await vi.advanceTimersByTimeAsync(300);
    controller.dispose(); finish?.(state(id(1))); await settle(); expect(changed).not.toHaveBeenCalled();
  });
});
