import { keys, object, text } from './officeLiveModel';

export interface OfficePetChoice { id: string; label: string }
export type OfficeAppearanceOverrides = Record<string, string>;
const IDENTITY = /^[A-Za-z0-9._-]{1,128}$/;

export function validOfficePetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\\:\u0000-\u001f\u007f]/.test(value)
    && value.split('/').every(part => part.trim().length > 0 && part !== '.' && part !== '..');
}

/** Overrides use the complete admitted binding identity; a reused tab cannot inherit another binding's choice. */
export function parseOfficeAppearanceOverrides(raw: unknown): OfficeAppearanceOverrides {
  const value = object(raw), entries = Object.entries(value);
  if (entries.length > 256 || new TextEncoder().encode(JSON.stringify(value)).length > 32000) throw new Error('sharedPreferencesError');
  for (const [key, petId] of entries) {
    const parts = key.split('/');
    if (parts.length !== 3 || parts.some(part => !IDENTITY.test(part) || part === '.' || part === '..') || !validOfficePetId(petId)) throw new Error('sharedPreferencesError');
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) as OfficeAppearanceOverrides;
}

export function parseOfficePetChoices(raw: unknown): OfficePetChoice[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 129 || new TextEncoder().encode(JSON.stringify(raw)).length > 32000) throw new Error('invalidStorage');
  const seen = new Set<string>();
  return raw.map(item => {
    const value = object(item); keys(value, ['id', 'label']);
    if (!validOfficePetId(value.id) || seen.has(value.id)) throw new Error('invalidStorage');
    seen.add(value.id); return { id: value.id, label: text(value.label, 256) };
  });
}

/** Reclaim retired bindings only when a new edit reaches the saved metadata limit. */
export function editOfficeAppearanceOverride(values: OfficeAppearanceOverrides, key: string, petId: string, admitted: ReadonlySet<string>): OfficeAppearanceOverrides {
  const next = { ...values };
  if (petId) next[key] = petId; else delete next[key];
  try { return parseOfficeAppearanceOverrides(next); }
  catch { return parseOfficeAppearanceOverrides(Object.fromEntries(Object.entries(next).filter(([source]) => admitted.has(source)))); }
}
