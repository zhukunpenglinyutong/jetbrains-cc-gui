import { describe, expect, it } from 'vitest';
import { computeAutoScrollDelta } from './useDragAutoScroll';

describe('computeAutoScrollDelta', () => {
  // Container spanning y=100..220; edge zone is 20px, max speed 8px/frame.
  const rect = { top: 100, bottom: 220 };

  it('returns 0 when the pointer is in the middle of the container', () => {
    expect(computeAutoScrollDelta(160, rect)).toBe(0);
  });

  it('treats the exact zone boundary as outside the zone', () => {
    expect(computeAutoScrollDelta(120, rect)).toBe(0);
    expect(computeAutoScrollDelta(200, rect)).toBe(0);
  });

  it('ramps scroll-up speed linearly inside the top edge zone', () => {
    // 10px deep into the 20px zone → half of max speed.
    expect(computeAutoScrollDelta(110, rect)).toBe(-4);
    // 1px deep → at least 1px/frame so the drag never stalls.
    expect(computeAutoScrollDelta(119, rect)).toBe(-1);
  });

  it('ramps scroll-down speed linearly inside the bottom edge zone', () => {
    expect(computeAutoScrollDelta(210, rect)).toBe(4);
    expect(computeAutoScrollDelta(201, rect)).toBe(1);
  });

  it('caps at max speed once the pointer travels beyond the container', () => {
    expect(computeAutoScrollDelta(50, rect)).toBe(-8);
    expect(computeAutoScrollDelta(300, rect)).toBe(8);
  });
});
