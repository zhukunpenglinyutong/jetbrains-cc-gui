import { describe, expect, it } from 'vitest';
import { shouldFlipEmbeddedNodeProcessDropdown } from './NodeProcessSelect';

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
});
