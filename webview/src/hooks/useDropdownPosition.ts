import { useState, useCallback } from 'react';
import { getAppViewport } from '../utils/viewport';

type DropdownAlignment = 'left' | 'right';

interface UseDropdownPositionOptions {
  buttonRef: React.RefObject<HTMLElement | null>;
  preferredAlignment?: DropdownAlignment;
  minWidth?: number;
  submenu?: boolean;
}

interface PositionState {
  left: number;
  bottom: number;
  maxHeight: number;
  submenuSide: 'right' | 'left';
}

const FALLBACK_ABSOLUTE_LEFT: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  left: 0,
};

const FALLBACK_ABSOLUTE_RIGHT: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  right: 0,
};

const FALLBACK_SUBMENU_RIGHT: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  left: '100%',
};

const FALLBACK_SUBMENU_LEFT: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  right: '100%',
};

/**
 * Hook that computes fixed-position styles for a dropdown to ensure
 * it stays completely within the visible #app viewport area.
 *
 * Uses the same coordinate-space Convention as the completion Dropdown:
 * all arithmetic is done in getBoundingClientRect space (which includes
 * CSS zoom), then divided by fixedPosDivisor for the final CSS values.
 *
 * For normal dropdowns: positions above the trigger button.
 * For submenus: positions beside the trigger row.
 */
export function useDropdownPosition({
  buttonRef,
  preferredAlignment = 'left',
  minWidth = 200,
  submenu = false,
}: UseDropdownPositionOptions): {
  positionedStyle: React.CSSProperties;
  maxHeight: number | undefined;
  recalculate: () => void;
} {
  const [positionState, setPositionState] = useState<PositionState | null>(null);

  const recalculate = useCallback(() => {
    const button = buttonRef.current;
    if (!button) {
      setPositionState(null);
      return;
    }

    const rect = button.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, top: viewportTop, left: viewportLeft } = getAppViewport();
    const padding = 8;

    // All coordinates are in getBoundingClientRect space (includes CSS zoom).
    // Subtract viewport offsets to make them relative to #app.
    const buttonLeft = rect.left - viewportLeft;
    const buttonRight = rect.right - viewportLeft;
    const buttonTop = rect.top - viewportTop;
    const buttonBottom = rect.bottom - viewportTop;

    if (submenu) {
      const side: 'right' | 'left' =
        buttonRight + minWidth + padding <= viewportWidth ? 'right' : 'left';

      let left: number;
      if (side === 'right') {
        left = buttonRight + padding;
      } else {
        left = buttonLeft - minWidth - padding;
      }
      left = Math.max(padding, Math.min(left, viewportWidth - minWidth - padding));

      // Submenu bottom aligns with button vertical center (half-height overlap)
      const submenuOverlap = rect.height / 2;
      const bottomValue = viewportHeight - buttonBottom + submenuOverlap;

      // Max height: from the submenu top to the viewport top (with padding)
      const submenuMaxHeight = buttonBottom - submenuOverlap - padding;

      setPositionState({ left, bottom: bottomValue, maxHeight: submenuMaxHeight, submenuSide: side });
      return;
    }

    // Normal dropdown: position above the button
    let left: number;
    if (preferredAlignment === 'right') {
      left = buttonRight - minWidth;
      if (left < padding) {
        left = buttonLeft;
      }
    } else {
      left = buttonLeft;
      if (left + minWidth + padding > viewportWidth) {
        left = buttonRight - minWidth;
      }
    }
    left = Math.max(padding, Math.min(left, viewportWidth - minWidth - padding));

    // Dropdown bottom edge sits just above the button top (with gap)
    const gap = 4;
    const bottomValue = viewportHeight - buttonTop + gap;

    // Max height: from the dropdown bottom (buttonTop - gap) to viewport top (with padding)
    const dropdownMaxHeight = buttonTop - gap - padding;

    setPositionState({ left, bottom: bottomValue, maxHeight: dropdownMaxHeight, submenuSide: 'right' });
  }, [buttonRef, preferredAlignment, minWidth, submenu]);

  if (!positionState) {
    if (submenu) {
      return {
        positionedStyle: preferredAlignment === 'left' ? FALLBACK_SUBMENU_RIGHT : FALLBACK_SUBMENU_LEFT,
        maxHeight: undefined,
        recalculate,
      };
    }
    return {
      positionedStyle: preferredAlignment === 'left' ? FALLBACK_ABSOLUTE_LEFT : FALLBACK_ABSOLUTE_RIGHT,
      maxHeight: undefined,
      recalculate,
    };
  }

  const { fixedPosDivisor } = getAppViewport();

  return {
    positionedStyle: {
      position: 'fixed',
      left: positionState.left / fixedPosDivisor,
      bottom: positionState.bottom / fixedPosDivisor,
      zIndex: submenu ? 10001 : 10000,
    },
    maxHeight: positionState.maxHeight / fixedPosDivisor,
    recalculate,
  };
}