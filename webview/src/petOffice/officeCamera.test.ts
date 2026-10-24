import { describe, expect, it } from 'vitest';
import { OFFICE_ART_SEATS } from './officeArtGeometry';
import { OFFICE_THEME_IDS } from './officeThemes';
import { officeArtCamera, officeCameraPoint, OFFICE_FULL_CAMERA } from './officeCamera';
import type { OfficeSource } from './officeModel';

const sources = (slots: number[]) => slots.map(seat => ({ seat }) as OfficeSource);

describe('selected desk camera', () => {
  it('limits magnification while retaining room context across wide and desktop viewports', () => {
    for (const theme of OFFICE_THEME_IDS) for (const aspect of [2.05, 1.48]) {
      const view = officeArtCamera(sources([0, 1]), theme, aspect, true);
      expect(1160 / view.width).toBeLessThanOrEqual(1.21);
      expect(1040 / view.height).toBeLessThanOrEqual(1.37);
      expect(view.height).toBeLessThan(1040);
    }
  });
  it('follows every selected actor and label, including crowded floors, for all nine rooms', () => {
    for (const theme of OFFICE_THEME_IDS) for (const aspect of [.6, 1.48, 2.05, 4]) {
      for (const slots of [[0], [0, 1], [0, 3], [4, 6], [0, 7], [0, 11], [10, 11]]) {
        const actors = sources(slots).map(source => ({ ...source, sourceKey: `desk-${source.seat}` }));
        for (const slot of slots) {
          const view = officeArtCamera(actors, theme, aspect, true, `desk-${slot}`);
          expect(view.x).toBeGreaterThanOrEqual(0); expect(view.y).toBeGreaterThanOrEqual(0);
          expect(view.x + view.width).toBeLessThanOrEqual(1160.0001);
          expect(view.y + view.height).toBeLessThanOrEqual(1040.0001);
          const seat = OFFICE_ART_SEATS[theme][slot];
          expect(view.x).toBeLessThanOrEqual(seat.x - seat.half);
          expect(view.x + view.width).toBeGreaterThanOrEqual(seat.x + seat.half);
          expect(view.y).toBeLessThanOrEqual(Math.max(0, seat.y - 165 * seat.scale));
          expect(view.y + view.height).toBeGreaterThanOrEqual(seat.label + 22);
          const point = officeCameraPoint(view, (seat.x - view.x) * 1400 / view.width, (seat.label - view.y) * 700 / view.height, 1400, 700);
          expect(point.x).toBeCloseTo(seat.x); expect(point.y).toBeCloseTo(seat.label);
        }
      }
    }
  });
  it('keeps overview/empty floors complete and rejects invalid aspect ratios', () => {
    for (const [slots, aspect, focus] of [[[], 2, true], [[0, 1], 2, false], [[0], NaN, true], [[0], 0, true]] as const) {
      expect(officeArtCamera(sources([...slots]), 'forest', aspect, focus)).toEqual(OFFICE_FULL_CAMERA);
    }
  });
  it('changes its center for a selected far desk and falls back safely for a filtered selection', () => {
    const actors = sources([0, 11]).map(source => ({ ...source, sourceKey: `desk-${source.seat}` }));
    const first = officeArtCamera(actors, 'loft', 1.4, true, 'desk-0');
    const last = officeArtCamera(actors, 'loft', 1.4, true, 'desk-11');
    expect(last.x).toBeGreaterThan(first.x); expect(last.y).toBeGreaterThan(first.y);
    expect(officeArtCamera(actors, 'loft', 1.4, true, 'missing')).toEqual(first);
  });
});
