import { describe, expect, it } from 'vitest';
import { shouldFlipNodeProcessDropdownLeft } from './NodeProcessSelect';

describe('NodeProcessSelect dropdown positioning', () => {
  it('keeps the submenu flipped left after right-side overflow is detected', () => {
    const anchorRect = { left: 190, right: 390 };
    const dropdownWidth = 350;
    const viewportWidth = 410;

    expect(shouldFlipNodeProcessDropdownLeft({
      anchorRect,
      dropdownWidth,
      viewportWidth,
    })).toBe(true);
  });

  it('keeps the submenu on the right when there is enough room', () => {
    const anchorRect = { left: 40, right: 240 };
    const dropdownWidth = 260;
    const viewportWidth = 700;

    expect(shouldFlipNodeProcessDropdownLeft({
      anchorRect,
      dropdownWidth,
      viewportWidth,
    })).toBe(false);
  });
});
