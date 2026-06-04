import { useState, useCallback, type CSSProperties, type RefObject } from 'react';
import { getAppViewport } from '../utils/viewport';

type DropdownAlignment = 'left' | 'right';

interface UseDropdownPositionOptions {
  buttonRef: RefObject<HTMLElement | null>;
  dropdownRef?: RefObject<HTMLElement | null>;
  preferredAlignment?: DropdownAlignment;
  minWidth?: number;
  submenuMaxHeight?: number;
  submenuBottomClearance?: number;
  submenu?: boolean;
}

interface PositionState {
  left?: number;
  top?: number | string;
  bottom?: number;
  maxHeight: number;
  submenuSide?: 'right' | 'left';
  submenuOverlap?: number;
}

const FALLBACK_ABSOLUTE_LEFT: CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  left: 0,
};

const FALLBACK_ABSOLUTE_RIGHT: CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  right: 0,
};

const FALLBACK_SUBMENU_RIGHT: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: '100%',
};

const FALLBACK_SUBMENU_LEFT: CSSProperties = {
  position: 'absolute',
  top: 0,
  right: '100%',
};

/**
 * Hook that computes dropdown styles to ensure
 * it stays completely within the visible #app viewport area.
 *
 * Uses the same coordinate-space Convention as the completion Dropdown:
 * all arithmetic is done in getBoundingClientRect space (which includes
 * CSS zoom), then divided by fixedPosDivisor for the final CSS values.
 *
 * For normal dropdowns: positions above the trigger button.
 * For submenus: positions beside the trigger row in the row's own coordinate space.
 */
export function useDropdownPosition({
  buttonRef,
  dropdownRef,
  preferredAlignment = 'left',
  minWidth = 200,
  submenuMaxHeight = 300,
  submenuBottomClearance = 96,
  submenu = false,
}: UseDropdownPositionOptions): {
  positionedStyle: CSSProperties;
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
    if (submenu) {
      const availableRight = Math.max(0, viewportWidth - padding - buttonRight);
      const availableLeft = Math.max(0, buttonLeft - padding);
      const side: 'right' | 'left' = availableRight >= minWidth
        ? 'right'
        : availableLeft >= minWidth
          ? 'left'
          : availableRight >= availableLeft ? 'right' : 'left';
      const availableSideWidth = side === 'right' ? availableRight : availableLeft;
      const submenuOverlap = Math.max(0, minWidth - availableSideWidth);
      const dropdown = dropdownRef?.current;
      const measuredHeight = dropdown
        ? Math.max(dropdown.getBoundingClientRect().height, dropdown.scrollHeight)
        : submenuMaxHeight;
      const desiredHeight = Math.min(submenuMaxHeight, Math.max(1, measuredHeight));
      const availableBelow = viewportHeight - padding - buttonTop;
      const minTopOffset = padding - buttonTop;
      const topOffset = Math.max(
        minTopOffset,
        Math.min(0, availableBelow - desiredHeight - submenuBottomClearance),
      );
      const availableHeight = viewportHeight - padding - buttonTop - topOffset;
      const maxHeight = Math.max(1, Math.min(submenuMaxHeight, availableHeight));

      setPositionState({ top: topOffset, maxHeight, submenuSide: side, submenuOverlap });
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
  }, [buttonRef, dropdownRef, preferredAlignment, minWidth, submenu, submenuBottomClearance, submenuMaxHeight]);

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

  if (submenu) {
    const sideStyle: CSSProperties = positionState.submenuSide === 'left'
      ? { right: '100%', marginRight: `-${positionState.submenuOverlap ?? 0}px` }
      : { left: '100%', marginLeft: `-${positionState.submenuOverlap ?? 0}px` };

    return {
      positionedStyle: {
        position: 'absolute',
        top: positionState.top,
        ...sideStyle,
        zIndex: 10001,
      },
      maxHeight: positionState.maxHeight,
      recalculate,
    };
  }

  return {
    positionedStyle: {
      position: 'fixed',
      left: (positionState.left ?? 0) / fixedPosDivisor,
      bottom: (positionState.bottom ?? 0) / fixedPosDivisor,
      zIndex: submenu ? 10001 : 10000,
    },
    maxHeight: positionState.maxHeight / fixedPosDivisor,
    recalculate,
  };
}
