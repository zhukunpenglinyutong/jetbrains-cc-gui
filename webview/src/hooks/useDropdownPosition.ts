import { useState, useCallback } from 'react';
import { getAppViewport } from '../utils/viewport';

type DropdownAlignment = 'left' | 'right';

interface UseDropdownPositionOptions {
  /**
   * Ref to the trigger button element.
   */
  buttonRef: React.RefObject<HTMLElement | null>;
  /**
   * Preferred side the dropdown should open to.
   * The hook will flip to the opposite side if there isn't enough room.
   * @default 'left'
   */
  preferredAlignment?: DropdownAlignment;
  /**
   * Estimated minimum width of the dropdown in px.
   * Used to check whether the dropdown fits when aligned to the preferred side.
   * @default 200
   */
  minWidth?: number;
  /**
   * If true, positions the dropdown to the right of the trigger (submenu style)
   * instead of above it. Falls back to `right: 100%` when space is tight.
   * @default false
   */
  submenu?: boolean;
}

/**
 * Hook that computes CSS left/right positioning for a dropdown to ensure
 * it stays within viewport boundaries.
 *
 * Returns a `positionedStyle` object to spread onto the dropdown element,
 * and a `recalculate` function that should be called when the dropdown opens.
 *
 * For normal dropdowns: positions above the button, aligning to preferred side,
 * flipping if there isn't enough room.
 * For submenus: positions to the right of the trigger, flipping to the left if
 * there isn't enough space on the right.
 */
export function useDropdownPosition({
  buttonRef,
  preferredAlignment = 'left',
  minWidth = 200,
  submenu = false,
}: UseDropdownPositionOptions): {
  positionedStyle: React.CSSProperties;
  recalculate: () => void;
} {
  const [alignedLeft, setAlignedLeft] = useState<boolean | null>(null);

  const recalculate = useCallback(() => {
    const button = buttonRef.current;
    if (!button) {
      setAlignedLeft(preferredAlignment === 'left');
      return;
    }

    const rect = button.getBoundingClientRect();
    const { width: viewportWidth, left: viewportLeft } = getAppViewport();

    const buttonLeft = rect.left - viewportLeft;
    const buttonRight = rect.right - viewportLeft;
    const padding = 10;

    if (submenu) {
      // Submenu opens to the right by default. Check right edge.
      if (buttonRight + minWidth + padding > viewportWidth) {
        // Not enough space on the right, flip to left side
        setAlignedLeft(false);
      } else {
        setAlignedLeft(true);
      }
    } else if (preferredAlignment === 'right') {
      // Right-aligned: check if the left edge would overflow viewport
      const dropdownLeft = buttonRight - minWidth;
      if (dropdownLeft < padding) {
        // Not enough space on the left, flip to left-aligned
        setAlignedLeft(true);
      } else {
        setAlignedLeft(false);
      }
    } else {
      // Left-aligned: check if the right edge would overflow viewport
      if (buttonLeft + minWidth + padding > viewportWidth) {
        // Not enough space on the right, flip to right-aligned
        setAlignedLeft(false);
      } else {
        setAlignedLeft(true);
      }
    }
  }, [buttonRef, preferredAlignment, minWidth, submenu]);

  const positionedStyle: React.CSSProperties =
    alignedLeft === null
      ? submenu
        ? { left: '100%' }
        : preferredAlignment === 'left'
          ? { left: 0 }
          : { right: 0 }
      : submenu
        ? alignedLeft
          ? { left: '100%' }
          : { left: 'auto', right: '100%' }
        : alignedLeft
          ? { left: 0 }
          : { right: 0 };

  return { positionedStyle, recalculate };
}
