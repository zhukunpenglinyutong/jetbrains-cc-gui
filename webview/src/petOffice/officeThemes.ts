import { OFFICE_MAX_FLOORS } from './officeModel';

export const OFFICE_THEME_IDS = ['loft', 'cyberpunk', 'cultivation', 'space', 'forest', 'library', 'ocean', 'zen', 'retro'] as const;
export type OfficeThemeId = typeof OFFICE_THEME_IDS[number];
const PREFERENCE_KEY = 'ccgui.pet.office.themes.v1';
const LEGACY_FLOOR_LIMIT = 16;
type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface OfficeThemePreferences { floors: OfficeThemeId[]; error: boolean }

export interface OfficeThemePalette {
  wall: readonly [string, string]; floor: readonly [string, string]; grid: string;
  chair: string; chairLight: string; deskEdge: string; deskTop: string; deskLeg: string;
  monitor: string; screen: string; label: string; text: string; accent: string;
}

export const OFFICE_THEME_PALETTES: Record<OfficeThemeId, OfficeThemePalette> = {
  loft: { wall: ['#f4eddf', '#dbcebb'], floor: ['#d6b99a', '#b99474'], grid: '#8a66462d',
    chair: '#62788e', chairLight: '#a4b2b2', deskEdge: '#b99171', deskTop: '#f4e6cd', deskLeg: '#856c58',
    monitor: '#3d5062', screen: '#8dabb8', label: '#f8f1e7ed', text: '#574a41', accent: '#b7a38a' },
  cyberpunk: { wall: ['#101728', '#272244'], floor: ['#20243b', '#10192b'], grid: '#6f74b52b',
    chair: '#655083', chairLight: '#806b9d', deskEdge: '#a04dba', deskTop: '#354366', deskLeg: '#4c526d',
    monitor: '#22243d', screen: '#547e9c', label: '#1b2034f5', text: '#dce8ff', accent: '#67e5e9' },
  cultivation: { wall: ['#e1f1e8', '#b8d4cb'], floor: ['#c7d8c3', '#9cbbb3'], grid: '#536f6930',
    chair: '#648b83', chairLight: '#a0b7a1', deskEdge: '#795d43', deskTop: '#c6a77b', deskLeg: '#6d5846',
    monitor: '#797350', screen: '#86baab', label: '#f0f3dfed', text: '#385950', accent: '#b39860' },
  space: { wall: ['#101c30', '#253d57'], floor: ['#31465c', '#192b41'], grid: '#86a8c42a',
    chair: '#597c99', chairLight: '#8ba9bc', deskEdge: '#64849d', deskTop: '#c0d5df', deskLeg: '#5b778a',
    monitor: '#23435b', screen: '#6ab1c4', label: '#193146f2', text: '#d9eef7', accent: '#7ccedf' },
  forest: { wall: ['#e7edda', '#a8c4a2'], floor: ['#ceb68e', '#a28c68'], grid: '#67563b25',
    chair: '#4e7766', chairLight: '#91aa84', deskEdge: '#886642', deskTop: '#edd9ae', deskLeg: '#715539',
    monitor: '#385c52', screen: '#9bc9b1', label: '#eff3ddf0', text: '#314f3e', accent: '#79a56a' },
  library: { wall: ['#292739', '#403447'], floor: ['#705448', '#403841'], grid: '#debb9220',
    chair: '#71607e', chairLight: '#a99bb3', deskEdge: '#8b6650', deskTop: '#c7a67e', deskLeg: '#624838',
    monitor: '#514565', screen: '#b9b4de', label: '#2d2739f2', text: '#f5e7cf', accent: '#dcbe80' },
  ocean: { wall: ['#173d51', '#286774'], floor: ['#344d59', '#193a4b'], grid: '#82c3c325',
    chair: '#3f7b88', chairLight: '#82b9c4', deskEdge: '#507e8b', deskTop: '#b4d4d4', deskLeg: '#3b6574',
    monitor: '#224f65', screen: '#6ed0d0', label: '#123d4cf2', text: '#d7f4ee', accent: '#72d9cf' },
  zen: { wall: ['#eeebdd', '#d4d7c0'], floor: ['#c9c9b4', '#a1ad99'], grid: '#52674e25',
    chair: '#647868', chairLight: '#a9b29b', deskEdge: '#80745a', deskTop: '#e3d7b6', deskLeg: '#6e6654',
    monitor: '#566958', screen: '#a2b8a2', label: '#f1efdcf0', text: '#3d5141', accent: '#8b9e7d' },
  retro: { wall: ['#342c3c', '#51404d'], floor: ['#84766f', '#504951'], grid: '#e3c6a32b',
    chair: '#947057', chairLight: '#cda07a', deskEdge: '#6b514e', deskTop: '#d2b992', deskLeg: '#68534c',
    monitor: '#a59680', screen: '#a0c98e', label: '#332b39f2', text: '#f6e6c7', accent: '#e5ba7f' },
};

function isTheme(value: unknown): value is OfficeThemeId { return OFFICE_THEME_IDS.some(theme => theme === value); }
function validFloors(value: unknown): value is OfficeThemeId[] {
  return Array.isArray(value) && (value.length === OFFICE_MAX_FLOORS || value.length === LEGACY_FLOOR_LIMIT) && value.every(isTheme);
}

/** Extend legacy floor settings without changing existing floor backgrounds or styles. */
export function normalizeOfficeThemeFloors(value: unknown): OfficeThemeId[] {
  if (!validFloors(value)) throw new Error('Invalid theme preferences');
  return Array.from({ length: OFFICE_MAX_FLOORS }, (_, index) => value[index] ?? 'loft');
}

/** Versioned, bounded local preferences. Custom background files remain in their own store. */
export function readOfficeThemePreferences(storage?: ThemeStorage): OfficeThemePreferences {
  const defaults: OfficeThemeId[] = Array.from({ length: OFFICE_MAX_FLOORS }, () => 'loft');
  try {
    const text = (storage ?? window.localStorage).getItem(PREFERENCE_KEY);
    if (text === null) return { floors: defaults, error: false };
    if (text.length > 1024) throw new Error('Invalid theme preferences');
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1
      || !('floors' in value) || !validFloors(value.floors) || Object.keys(value).length !== 2) throw new Error('Invalid theme preferences');
    return { floors: normalizeOfficeThemeFloors(value.floors), error: false };
  } catch { return { floors: defaults, error: true }; }
}

export function writeOfficeThemePreferences(floors: OfficeThemeId[], storage?: ThemeStorage): boolean {
  if (!validFloors(floors) || floors.length !== OFFICE_MAX_FLOORS) return false;
  try { (storage ?? window.localStorage).setItem(PREFERENCE_KEY, JSON.stringify({ schemaVersion: 1, floors })); return true; }
  catch { return false; }
}
