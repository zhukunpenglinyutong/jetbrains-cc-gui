import { describe, expect, it } from 'vitest';
import { computeResize } from './useResizableChatInputBox.js';

describe('useResizableChatInputBox/computeResize', () => {
  it('keeps current height when no vertical drag', () => {
    const bounds = { minWrapperHeightPx: 96, maxWrapperHeightPx: 400 };
    const start = { startY: 0, startWrapperHeightPx: 200 };

    expect(computeResize(start, { y: 0 }, bounds)).toEqual({
      wrapperHeightPx: 200,
    });
  });

  it('resizes height on north handle (drag up increases) and clamps to bounds', () => {
    const bounds = { minWrapperHeightPx: 96, maxWrapperHeightPx: 240 };
    const start = { startY: 100, startWrapperHeightPx: 120 };

    // drag to y=50 => dy = 50 - 100 = -50 => height = 120 - (-50) = 170
    expect(computeResize(start, { y: 50 }, bounds).wrapperHeightPx).toBe(170);

    // drag to y=0 => dy = 0 - 100 = -100 => height = 120 + 100 = 220
    expect(computeResize(start, { y: 0 }, bounds).wrapperHeightPx).toBe(220);

    // clamp to max: drag to y=-200 => dy = -300 => height = 420, clamped to 240
    expect(computeResize(start, { y: -200 }, bounds).wrapperHeightPx).toBe(240);

    // clamp to min: drag to y=500 => dy = 400 => height = -280, clamped to 96
    expect(computeResize(start, { y: 500 }, bounds).wrapperHeightPx).toBe(96);
  });

  it('clamps height within bounds for large drag', () => {
    const bounds = { minWrapperHeightPx: 96, maxWrapperHeightPx: 520 };
    const start = { startY: 10, startWrapperHeightPx: 200 };

    // drag up by 50 => dy = -40 - 10 = -50 => height = 200 + 50 = 250
    const next = computeResize(start, { y: -40 }, bounds);
    expect(next).toEqual({ wrapperHeightPx: 250 });
  });
});
