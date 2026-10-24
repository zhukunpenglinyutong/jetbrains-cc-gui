import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFICE_MARGIN_MODES, officeMarginLayout, readOfficeMarginPreferences, writeOfficeMarginPreferences } from './officeMarginEffects';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); vi.restoreAllMocks(); });

describe('margin effect resource boundaries', () => {
  it('uses only spare side space and collapses when the room fills or exceeds the viewport', () => {
    expect(officeMarginLayout(1300, 800, 880, 2).width).toBe(210);
    for (const roomWidth of [1250, 1300, 1600]) expect(officeMarginLayout(1300, 800, roomWidth, 2).width).toBe(0);
  });
  it('bounds both strips below 4 MiB even on large high DPI displays', () => {
    for (const [width, height, roomWidth, dpr] of [[3840, 2160, 1200, 3], [7680, 4320, 1600, 4], [1300, 800, 880, 1.5]]) {
      const layout = officeMarginLayout(width, height, roomWidth, dpr);
      expect(layout.pixelWidth * layout.pixelHeight * 8).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(layout.width * 2 + roomWidth).toBeLessThanOrEqual(width);
    }
  });
  it('never allocates a surface from invalid measurements', () => {
    for (const size of [0, -1, NaN, Infinity]) expect(officeMarginLayout(size, 800, 500, 2)).toEqual({ width: 0, height: 0, pixelWidth: 1, pixelHeight: 1 });
  });
});

describe('window decoration preferences', () => {
  it.each(OFFICE_MARGIN_MODES)('remembers off separately from %s across reopen', mode => {
    expect(writeOfficeMarginPreferences({ enabled: false, mode })).toBe(true);
    expect(readOfficeMarginPreferences()).toEqual({ enabled: false, mode });
  });
  it('recovers from corrupt, oversized or unknown saved effects', () => {
    for (const value of ['null', '{', 'x'.repeat(100), '{"enabled":true,"mode":"external"}', '{"enabled":"true","mode":"rain"}', '{"enabled":true,"mode":"rain","url":"https://example.test"}']) {
      localStorage.setItem('ccgui.pet.office.margin-effects.v1', value);
      expect(readOfficeMarginPreferences()).toEqual({ enabled: true, mode: 'aurora' });
    }
  });
  it('keeps the window usable when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readOfficeMarginPreferences()).toEqual({ enabled: true, mode: 'aurora' });
    expect(writeOfficeMarginPreferences({ enabled: true, mode: 'matrix' })).toBe(false);
  });
});
