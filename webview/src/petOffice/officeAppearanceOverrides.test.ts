import { describe, expect, it } from 'vitest';
import { editOfficeAppearanceOverride, parseOfficeAppearanceOverrides, parseOfficePetChoices } from './officeAppearanceOverrides';

describe('Office session appearance boundaries', () => {
  it('reclaims retired choices at capacity while preserving every admitted binding', () => {
    const values = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`ide/tab/b${i}`, 'builtin']));
    const admitted = new Set(['ide/tab/b1', 'ide/new/binding']);
    expect(editOfficeAppearanceOverride(values, 'ide/new/binding', 'duck.png', admitted)).toEqual({ 'ide/new/binding': 'duck.png', 'ide/tab/b1': 'builtin' });
    expect(Object.keys(values)).toHaveLength(256);
    expect(editOfficeAppearanceOverride({ 'ide/tab/b1': 'builtin' }, 'ide/new/binding', '', admitted)).toEqual({ 'ide/tab/b1': 'builtin' });
  });
  it('keeps complete binding identities independent and accepts local Pet package IDs', () => {
    const values = { 'ide/tab/old': 'mascot/spritesheet.png', 'ide/tab/new': 'builtin', 'other/tab/old': '自定义.png' };
    expect(parseOfficeAppearanceOverrides(values)).toEqual(values);
    expect(parseOfficeAppearanceOverrides(values)).not.toBe(values);
  });
  it('rejects traversal, malformed identities, extra structures and excessive saved metadata', () => {
    for (const value of [null, [], { 'ide/tab': 'builtin' }, { 'ide/tab/..': 'builtin' }, { 'ide/tab/binding': '../secret.png' },
      { 'ide/tab/binding': '/file.png' }, { 'ide/tab/binding': 'F:/file.png' }, { 'ide/tab/binding': 'a\\b.png' },
      { 'ide/tab/binding': { petId: 'builtin' } }, { 'ide/tab/binding': 'x\n.png' },
      Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`ide/tab/b${i}`, 'builtin'])),
      Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`ide/tab/b${i}`, 'x'.repeat(180)]))]) {
      expect(() => parseOfficeAppearanceOverrides(value)).toThrow();
    }
  });
  it('validates choice replies without accepting paths, duplicate IDs or unknown metadata', () => {
    const valid = [{ id: 'builtin', label: 'Robot' }, { id: 'duck/spritesheet.png', label: 'Duck' }];
    expect(parseOfficePetChoices(valid)).toEqual(valid);
    for (const invalid of [[], [...valid, valid[0]], [{ id: '../outside.png', label: 'Outside' }], [{ ...valid[0], path: 'outside' }]]) {
      expect(() => parseOfficePetChoices(invalid)).toThrow();
    }
  });
});
