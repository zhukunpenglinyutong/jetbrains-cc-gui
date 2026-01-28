import { describe, expect, it } from 'vitest';
import { computeResize } from './useResizableChatInputBox.js';

describe('useResizableChatInputBox/computeResize', () => {
  it('resizes width on east handle and clamps to bounds', () => {
    const bounds = { minWidthPx: 320, maxWidthPx: 500, minWrapperHeightPx: 96, maxWrapperHeightPx: 400 };
    const start = { startX: 0, startY: 0, startWidthPx: 400, startWrapperHeightPx: 200 };

    expect(computeResize(start, { x: 50, y: 0 }, 'e', bounds)).toEqual({
      widthPx: 450,
      wrapperHeightPx: 200,
    });

    // clamp
    expect(computeResize(start, { x: 200, y: 0 }, 'e', bounds).widthPx).toBe(500);
    expect(computeResize(start, { x: -200, y: 0 }, 'e', bounds).widthPx).toBe(320);
  });

  it('resizes height on north handle (drag up increases) and clamps to bounds', () => {
    const bounds = { minWidthPx: 320, maxWidthPx: 900, minWrapperHeightPx: 96, maxWrapperHeightPx: 240 };
    const start = { startX: 0, startY: 100, startWidthPx: 600, startWrapperHeightPx: 120 };

    // drag up (y smaller) => height increases
    expect(computeResize(start, { x: 0, y: 50 }, 'n', bounds).wrapperHeightPx).toBe(170);

    // clamp
    expect(computeResize(start, { x: 0, y: 0 }, 'n', bounds).wrapperHeightPx).toBe(220);
    expect(computeResize(start, { x: 0, y: 500 }, 'n', bounds).wrapperHeightPx).toBe(96);
  });

  it('resizes both on north-east handle', () => {
    const bounds = { minWidthPx: 320, maxWidthPx: 900, minWrapperHeightPx: 96, maxWrapperHeightPx: 520 };
    const start = { startX: 10, startY: 10, startWidthPx: 500, startWrapperHeightPx: 200 };

    const next = computeResize(start, { x: 60, y: -40 }, 'ne', bounds);
    expect(next).toEqual({ widthPx: 550, wrapperHeightPx: 250 });
  });
});

