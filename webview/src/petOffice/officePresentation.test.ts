import { describe, expect, it } from 'vitest';
import { OFFICE_CUSTOM_UI, OFFICE_PRESENTATION_DEFAULTS, OFFICE_UI_PALETTES, parseOfficePresentation } from './officePresentation';
import { parseOfficeSharedState } from './officeSharedStorage';

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}

describe('Office presentation preferences and palette', () => {
  it('keeps small text readable against the room-matched UI surfaces', () => {
    for (const palette of [...Object.values(OFFICE_UI_PALETTES), OFFICE_CUSTOM_UI]) for (const text of [palette.text, palette.muted, palette.accent]) {
      for (const surface of [palette.background, palette.panel, palette.surface, palette.selected]) {
        expect((luminance(text) + .05) / (luminance(surface) + .05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('normalizes legacy shared records and rejects partial, mistyped or extra visual fields', () => {
    const legacy = { schemaVersion: 1, revision: 'initial', preferences: { limitMiB: 50, floors: Array(16).fill('loft'), floor: 0, product: 'all', search: '', showIdle: false, paused: false, topmost: true, zoom: 100 }, bounds: { x: 0, y: 0, width: 1240, height: 900, placed: false } };
    expect(parseOfficeSharedState(legacy).preferences.presentation).toEqual(OFFICE_PRESENTATION_DEFAULTS);
    for (const invalid of [null, {}, { ...OFFICE_PRESENTATION_DEFAULTS, depth: 'true' }, { ...OFFICE_PRESENTATION_DEFAULTS, path: 'bad' }]) {
      expect(() => parseOfficePresentation(invalid)).toThrow();
      expect(() => parseOfficeSharedState({ ...legacy, preferences: { ...legacy.preferences, presentation: invalid } })).toThrow();
    }
  });
  it('retires legacy enabled depth without resetting the other saved settings', () => {
    expect(parseOfficePresentation({ effects: false, attention: true, ambience: false, depth: true }))
      .toEqual({ effects: false, attention: true, ambience: false, depth: false });
  });
});
