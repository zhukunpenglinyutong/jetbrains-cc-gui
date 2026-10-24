import { describe, expect, it } from 'vitest';
import { OFFICE_ART_SEATS } from './officeArtGeometry';
import { OFFICE_THEME_IDS } from './officeThemes';
import { OFFICE_FLOOR_CAPACITY } from './officeModel';

describe('bundled room geometry', () => {
  it('keeps all twelve stable seats and labels inside every SVG scene without adjacent row overlap', () => {
    for (const theme of OFFICE_THEME_IDS) {
      const seats = OFFICE_ART_SEATS[theme];
      expect(seats).toHaveLength(OFFICE_FLOOR_CAPACITY);
      for (const [index, seat] of seats.entries()) {
        expect(seat.x - seat.half).toBeGreaterThanOrEqual(0);
        expect(seat.x + seat.half).toBeLessThanOrEqual(1160);
        expect(seat.scale).toBeGreaterThan(0);
        expect(seat.y - 165 * seat.scale).toBeGreaterThan(0);
        expect(seat.label - 5).toBeGreaterThan(seat.bottom);
        expect(seat.label + 22).toBeLessThan(1040);
        expect(seat.front).toBeLessThan(seat.bottom);
        if (index >= 4) {
          const previous = seats[index - 4];
          const actorHeight = Math.min(144 * seat.scale, seat.y - previous.label - 30);
          expect(seat.y - actorHeight).toBeGreaterThan(previous.label + 22);
          expect(seat.scale).toBeGreaterThan(previous.scale);
        }
      }
    }
  });
});
