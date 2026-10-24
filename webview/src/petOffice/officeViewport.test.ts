import { describe, expect, it } from 'vitest';
import { fitOfficeSceneWidth } from './officeViewport';

describe('Office scene viewport fitting', () => {
  it('fits sparse and crowded rooms into full-HD and scaled desktop viewports', () => {
    for (const [width, height] of [[1460, 810], [880, 520], [600, 400], [330, 430]]) {
      for (const sceneHeight of [608, 824, 1040]) {
        const fitted = fitOfficeSceneWidth(width, height, sceneHeight);
        expect(fitted).toBeLessThanOrEqual(width);
        expect(fitted * sceneHeight / 1160).toBeLessThanOrEqual(height);
        expect(Math.max(fitted / width, fitted * sceneHeight / 1160 / height)).toBeGreaterThan(.99);
      }
    }
  });
  it('keeps temporarily hidden and invalid dimensions bounded', () => {
    for (const [width, height, sceneHeight] of [[0, 800, 608], [1200, 0, 608], [1200, 800, 0], [NaN, 800, 608], [1200, Infinity, 608]]) {
      expect(fitOfficeSceneWidth(width, height, sceneHeight)).toBe(1);
    }
  });
});
