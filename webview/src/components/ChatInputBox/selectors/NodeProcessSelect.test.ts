import { describe, expect, it } from 'vitest';
import {
  getEmbeddedNodeProcessDropdownLayout,
  shouldFlipEmbeddedNodeProcessDropdown,
} from './NodeProcessSelect';

describe('shouldFlipEmbeddedNodeProcessDropdown', () => {
  it('flips when the normal right-side placement overflows and left fits better', () => {
    expect(shouldFlipEmbeddedNodeProcessDropdown(
      { left: 230, right: 470 },
      320,
      500,
    )).toBe(true);
  });

  it('does not flip when the normal placement fits', () => {
    expect(shouldFlipEmbeddedNodeProcessDropdown(
      { left: 60, right: 180 },
      260,
      600,
    )).toBe(false);
  });

  it('keeps one stable answer instead of depending on the rendered side', () => {
    const parentRect = { left: 230, right: 470 };
    const firstPass = shouldFlipEmbeddedNodeProcessDropdown(parentRect, 320, 500);
    const secondPass = shouldFlipEmbeddedNodeProcessDropdown(parentRect, 320, 500);

    expect(firstPass).toBe(true);
    expect(secondPass).toBe(firstPass);
  });

  it('caps width to the selected side when no full-size placement fits', () => {
    expect(getEmbeddedNodeProcessDropdownLayout(
      { left: 24, right: 224 },
      360,
      393,
    )).toEqual({ flipToLeft: false, maxWidth: 180, maxHeight: 380, topOffset: 0, horizontalOverlap: 19 });
  });

  it('does not overlap the parent menu edge when the submenu fits normally', () => {
    expect(getEmbeddedNodeProcessDropdownLayout(
      { left: 24, right: 224 },
      320,
      900,
    )).toEqual({ flipToLeft: false, maxWidth: 360, maxHeight: 380, topOffset: 0, horizontalOverlap: 0 });
  });

  it('prefers a narrower flush panel over unnecessary overlap', () => {
    expect(getEmbeddedNodeProcessDropdownLayout(
      { left: 24, right: 277 },
      360,
      496,
    )).toEqual({ flipToLeft: false, maxWidth: 211, maxHeight: 380, topOffset: 0, horizontalOverlap: 0 });
  });

  it('shifts upward instead of clipping when space below the trigger row is tight', () => {
    expect(getEmbeddedNodeProcessDropdownLayout(
      { left: 24, right: 224, top: 700 },
      320,
      900,
      800,
      0,
      180,
    )).toEqual({ flipToLeft: false, maxWidth: 360, maxHeight: 252, topOffset: -160, horizontalOverlap: 0 });
  });

  it('only caps height when the panel cannot fully fit even after shifting', () => {
    expect(getEmbeddedNodeProcessDropdownLayout(
      { left: 24, right: 224, top: 20 },
      320,
      900,
      160,
      0,
      260,
    )).toEqual({ flipToLeft: false, maxWidth: 360, maxHeight: 144, topOffset: -12, horizontalOverlap: 0 });
  });
});
