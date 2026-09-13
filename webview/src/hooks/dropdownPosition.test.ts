import { describe, expect, it } from 'vitest';
import { getSubmenuLayout, isSubmenuHeightClipped } from './dropdownPosition';

const viewport = { width: 420, height: 700, left: 0, top: 0 };

describe('getSubmenuLayout', () => {
  it('flips a wide model submenu left and overlaps the trigger so it stays in view', () => {
    const layout = getSubmenuLayout({
      trigger: { left: 180, right: 400, top: 520, bottom: 548, width: 220, height: 28 },
      viewport,
      measuredWidth: 320,
      measuredHeight: 280,
      minWidth: 220,
      maxWidth: 360,
    });

    expect(layout.side).toBe('left');
    expect(layout.maxWidth).toBe(320);
    expect(layout.overlap).toBeGreaterThan(0);
    expect(layout.maxWidth - layout.overlap).toBeLessThanOrEqual(180 - 8);
  });

  it('keeps the submenu on the right when there is enough room', () => {
    const layout = getSubmenuLayout({
      trigger: { left: 24, right: 220, top: 80, bottom: 108, width: 196, height: 28 },
      viewport: { width: 800, height: 700, left: 0, top: 0 },
      measuredWidth: 260,
      minWidth: 220,
    });

    expect(layout.side).toBe('right');
    expect(layout.overlap).toBe(0);
  });

  it('uses measured width for overlap instead of minWidth so long labels are not clipped', () => {
    const layout = getSubmenuLayout({
      trigger: { left: 200, right: 400, top: 500, bottom: 528, width: 200, height: 28 },
      viewport: { width: 410, height: 700, left: 0, top: 0 },
      measuredWidth: 320,
      minWidth: 220,
      maxWidth: 360,
    });

    expect(layout.overlap).toBe(Math.max(0, 320 - (200 - 8)));
    expect(layout.maxWidth).toBe(320);
  });

  it('clamps a submenu that is taller than the remaining viewport', () => {
    const layout = getSubmenuLayout({
      trigger: { left: 40, right: 240, top: 620, bottom: 648, width: 200, height: 28 },
      viewport: { width: 400, height: 700, left: 0, top: 0 },
      measuredHeight: 400,
      maxHeight: 300,
      bottomClearance: 16,
    });

    expect(layout.topOffset + layout.maxHeight).toBeLessThanOrEqual(700 - 8 - 620);
    expect(layout.maxHeight).toBeGreaterThan(0);
  });

  it('does not treat a fitting submenu as clipped, including 1-2px rounding slack', () => {
    const layout = getSubmenuLayout({
      trigger: { left: 24, right: 220, top: 80, bottom: 108, width: 196, height: 28 },
      viewport: { width: 800, height: 700, left: 0, top: 0 },
      measuredHeight: 240,
      maxHeight: 480,
    });

    expect(layout.maxHeight).toBe(240);
    expect(isSubmenuHeightClipped(layout.maxHeight, 240)).toBe(false);
    expect(isSubmenuHeightClipped(layout.maxHeight, 241)).toBe(false);
    expect(isSubmenuHeightClipped(layout.maxHeight, 242)).toBe(false);
  });

  it('treats a submenu as clipped when measured height exceeds available space', () => {
    const layout = getSubmenuLayout({
      trigger: { left: 40, right: 240, top: 200, bottom: 228, width: 200, height: 28 },
      viewport: { width: 400, height: 220, left: 0, top: 0 },
      measuredHeight: 260,
      maxHeight: 480,
      bottomClearance: 16,
    });

    expect(layout.maxHeight).toBeLessThan(260);
    expect(isSubmenuHeightClipped(layout.maxHeight, 260)).toBe(true);
  });
});

describe('isSubmenuHeightClipped', () => {
  it('reports a clip only when overflow exceeds the 2px slack', () => {
    expect(isSubmenuHeightClipped(240, 240)).toBe(false);
    expect(isSubmenuHeightClipped(239, 240)).toBe(false);
    expect(isSubmenuHeightClipped(238, 240)).toBe(false);
    expect(isSubmenuHeightClipped(237, 240)).toBe(true);
    expect(isSubmenuHeightClipped(180, 240)).toBe(true);
  });
});
