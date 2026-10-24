import { describe, expect, it, vi } from 'vitest';
import { OFFICE_MIB, readOfficeCachePreferences, writeOfficeCachePreferences, resolveOfficeCacheBudget } from './officeCachePreferences';

describe('Office decoded cache preferences', () => {
  it('defaults to 50 MiB and persists an independent bounded Office preference', () => {
    let text: string | null = null;
    const storage = { getItem: vi.fn(() => text), setItem: vi.fn((_key: string, value: string) => { text = value; }) };
    expect(readOfficeCachePreferences(storage)).toEqual({ limitMiB: 50, error: false });
    expect(writeOfficeCachePreferences(128, storage)).toBe(true);
    expect(readOfficeCachePreferences(storage)).toEqual({ limitMiB: 128, error: false });
    expect(storage.setItem).toHaveBeenCalledWith('ccgui.pet.office.cache.v1', JSON.stringify({ schemaVersion: 1, limitMiB: 128 }));
  });
  it('rejects unversioned, extra, fractional and out-of-range values with a usable default', () => {
    for (const text of ['bad', ' '.repeat(129), 'null', '{"limitMiB":50}', '{"schemaVersion":2,"limitMiB":50}',
      '{"schemaVersion":1,"limitMiB":50,"extra":1}', ...[15, 257, 50.5, '50'].map(limitMiB => JSON.stringify({ schemaVersion: 1, limitMiB }))]) {
      expect(readOfficeCachePreferences({ getItem: () => text, setItem: vi.fn() })).toEqual({ limitMiB: 50, error: true });
    }
  });
  it('reports denied storage and rejects invalid writes and runtime budget values', () => {
    const storage = { getItem: () => { throw new Error('denied'); }, setItem: vi.fn(() => { throw new Error('denied'); }) };
    expect(readOfficeCachePreferences(storage)).toEqual({ limitMiB: 50, error: true });
    expect(writeOfficeCachePreferences(50, storage)).toBe(false);
    for (const value of [NaN, Infinity, 0, 15, 257, 50.5]) expect(writeOfficeCachePreferences(value, storage)).toBe(false);
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(resolveOfficeCacheBudget()).toBe(50 * OFFICE_MIB);
    expect(resolveOfficeCacheBudget(Infinity)).toBe(50 * OFFICE_MIB);
    expect(resolveOfficeCacheBudget(256 * OFFICE_MIB)).toBe(256 * OFFICE_MIB);
  });
});
