import { text } from './officeLiveModel';

export const OFFICE_NAME_MAX_LENGTH = 64;
const PREFERENCE_KEY = 'ccgui.pet.office.name.v1';

export function parseOfficeName(value: unknown): string {
  const name = text(value, OFFICE_NAME_MAX_LENGTH);
  if (/[\u0080-\u009f]/u.test(name)) throw new Error('officeNameInvalid');
  return name;
}

export function readOfficeName(): { name: string; error: boolean } {
  try { return { name: parseOfficeName(localStorage.getItem(PREFERENCE_KEY) ?? ''), error: false }; }
  catch { return { name: '', error: true }; }
}

export function writeOfficeName(name: string): boolean {
  try { localStorage.setItem(PREFERENCE_KEY, parseOfficeName(name)); return true; }
  catch { return false; }
}
