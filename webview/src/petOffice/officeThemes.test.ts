import { describe, expect, it, vi } from 'vitest';
import { readOfficeThemePreferences, writeOfficeThemePreferences } from './officeThemes';
import type { OfficeThemeId } from './officeThemes';
import { OFFICE_MAX_FLOORS } from './officeModel';

describe('floor scene preferences', () => {
  it('restores all five illustrated themes independently across floors', () => {
    let saved: string | null = null;
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    const floors = readOfficeThemePreferences(storage).floors;
    const illustrated: OfficeThemeId[] = ['forest', 'library', 'ocean', 'zen', 'retro'];
    illustrated.forEach((theme, index) => { floors[index * 3] = theme; });
    expect(writeOfficeThemePreferences(floors, storage)).toBe(true);
    expect(readOfficeThemePreferences(storage)).toEqual({ floors, error: false });
  });
  it('persists independent floor styles without touching custom image storage', () => {
    let value: string | null = null;
    const storage = { getItem: vi.fn(() => value), setItem: vi.fn((_key: string, next: string) => { value = next; }) };
    const initial = readOfficeThemePreferences(storage);
    expect(initial.error).toBe(false);
    initial.floors[0] = 'cyberpunk'; initial.floors[1] = 'cultivation'; initial.floors[21] = 'space';
    expect(writeOfficeThemePreferences(initial.floors, storage)).toBe(true);
    const restored = readOfficeThemePreferences(storage);
    expect(restored).toEqual(initial);
    restored.floors[1] = 'loft'; expect(writeOfficeThemePreferences(restored.floors, storage)).toBe(true);
    expect(readOfficeThemePreferences(storage).floors).toEqual(['cyberpunk', ...Array.from({ length: 20 }, () => 'loft'), 'space']);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(storage.setItem.mock.calls.every(([key]) => key === 'ccgui.pet.office.themes.v1')).toBe(true);
  });
  it('rejects corrupt, unknown, unversioned and unbounded preferences with a usable fallback', () => {
    const floors = Array.from({ length: OFFICE_MAX_FLOORS }, () => 'loft');
    for (const value of ['invalid', ' '.repeat(1025), JSON.stringify({ schemaVersion: 2, floors }),
      JSON.stringify({ floors }), JSON.stringify({ schemaVersion: 1, floors, path: 'extra' }),
      JSON.stringify({ schemaVersion: 1, floors: [...floors, 'space'] }),
      JSON.stringify({ schemaVersion: 1, floors: ['unknown', ...floors.slice(1)] })]) {
      expect(readOfficeThemePreferences({ getItem: () => value, setItem: vi.fn() })).toEqual({ floors, error: true });
    }
  });
  it('reports denied storage and rejects malformed writes rather than claiming persistence', () => {
    const storage = { getItem: () => { throw new Error('denied'); }, setItem: vi.fn(() => { throw new Error('denied'); }) };
    const fallback = readOfficeThemePreferences(storage);
    expect(fallback.error).toBe(true); expect(fallback.floors).toHaveLength(OFFICE_MAX_FLOORS);
    expect(writeOfficeThemePreferences(fallback.floors, storage)).toBe(false);
    expect(writeOfficeThemePreferences([] as OfficeThemeId[], storage)).toBe(false);
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it('preserves legacy floor styles while adding settings for all 22 floors', () => {
    const floors = Array.from({ length: 16 }, (_, index) => index === 15 ? 'ocean' : 'forest');
    let value = JSON.stringify({ schemaVersion: 1, floors });
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
    const restored = readOfficeThemePreferences(storage);
    expect(restored.error).toBe(false);
    expect(restored.floors).toEqual([...floors, ...Array.from({ length: 6 }, () => 'loft')]);
    restored.floors[21] = 'retro';
    expect(writeOfficeThemePreferences(restored.floors, storage)).toBe(true);
    expect(readOfficeThemePreferences(storage)).toEqual(restored);
  });
});
