import type { CSSProperties } from 'react';
import type { OfficeThemeId } from './officeThemes';

// Retain the retired depth field only for compatibility with persisted native records.
export interface OfficePresentationPreferences { effects: boolean; attention: boolean; ambience: boolean; depth: boolean }
export const OFFICE_PRESENTATION_DEFAULTS: OfficePresentationPreferences = { effects: true, attention: true, ambience: true, depth: false };
const PREFERENCE_KEY = 'ccgui.pet.office.presentation.v1';

export function parseOfficePresentation(value: unknown): OfficePresentationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sharedPreferencesError');
  const item = value as Record<string, unknown>;
  const names = ['effects', 'attention', 'ambience', 'depth'] as const;
  if (Object.keys(item).length !== names.length || names.some(name => typeof item[name] !== 'boolean')) throw new Error('sharedPreferencesError');
  return { effects: item.effects as boolean, attention: item.attention as boolean, ambience: item.ambience as boolean, depth: false };
}

export function readOfficePresentation(): OfficePresentationPreferences {
  try { const saved = localStorage.getItem(PREFERENCE_KEY); return saved && saved.length < 160 ? parseOfficePresentation(JSON.parse(saved)) : { ...OFFICE_PRESENTATION_DEFAULTS }; }
  catch { return { ...OFFICE_PRESENTATION_DEFAULTS }; }
}
export function writeOfficePresentation(value: OfficePresentationPreferences): boolean {
  try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(parseOfficePresentation(value))); return true; }
  catch { return false; }
}

export interface OfficeUiPalette { background: string; panel: string; surface: string; border: string; text: string; muted: string; accent: string; selected: string; scrollbar: string }
export const OFFICE_CUSTOM_UI: OfficeUiPalette = { background: '#111820', panel: '#19222c', surface: '#202d37', border: '#3c4b57', text: '#e8eef0', muted: '#a1b5bf', accent: '#a5d8be', selected: '#293e37', scrollbar: '#526574' };
export const OFFICE_UI_PALETTES: Record<OfficeThemeId, OfficeUiPalette> = {
  loft: { background: '#1d1915', panel: '#29231d', surface: '#352c23', border: '#60503e', text: '#f4ecdf', muted: '#c0af99', accent: '#ddbd87', selected: '#4a3b28', scrollbar: '#89745a' },
  cyberpunk: { background: '#111522', panel: '#1a2032', surface: '#242b42', border: '#434969', text: '#e8efff', muted: '#a5b4d3', accent: '#7ce2e8', selected: '#273e52', scrollbar: '#64749b' },
  cultivation: { background: '#172320', panel: '#21312b', surface: '#2c3e35', border: '#50665a', text: '#edf4e9', muted: '#b2c4b4', accent: '#d7c591', selected: '#414b32', scrollbar: '#728875' },
  space: { background: '#111d29', panel: '#1a2c3a', surface: '#243b4d', border: '#43617a', text: '#e9f3fc', muted: '#a6c0d3', accent: '#91d9ef', selected: '#284b63', scrollbar: '#648aa6' },
  forest: { background: '#172018', panel: '#233025', surface: '#2f3e2e', border: '#52664b', text: '#edf3e3', muted: '#b4c3a8', accent: '#bbd39a', selected: '#425236', scrollbar: '#7a8b66' },
  library: { background: '#1d1924', panel: '#2a2332', surface: '#382e3f', border: '#63516c', text: '#f4ecf6', muted: '#c5afcb', accent: '#e2c48b', selected: '#4a3c40', scrollbar: '#8c7395' },
  ocean: { background: '#102027', panel: '#18313a', surface: '#21414b', border: '#3c6871', text: '#e4f5f1', muted: '#9ec6c8', accent: '#8cddd4', selected: '#28544f', scrollbar: '#5b9295' },
  zen: { background: '#20241e', panel: '#2b3228', surface: '#394134', border: '#5e6a54', text: '#f0f1e2', muted: '#bec6b0', accent: '#cbd1a3', selected: '#4a5239', scrollbar: '#89937a' },
  retro: { background: '#241c23', panel: '#332730', surface: '#44343c', border: '#705561', text: '#fae9e4', muted: '#d0b1b5', accent: '#edc08c', selected: '#584033', scrollbar: '#9d7781' },
};

export function officeUiStyle(palette: OfficeUiPalette): CSSProperties {
  return Object.fromEntries(Object.entries(palette).map(([name, color]) => [`--office-${name}`, color])) as CSSProperties;
}
