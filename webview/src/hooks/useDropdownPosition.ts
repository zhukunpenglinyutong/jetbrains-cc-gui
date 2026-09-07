import { useCallback, useState, type CSSProperties, type RefObject } from 'react';
import { getAppViewport } from '../utils/viewport';
import {
  getMainDropdownLayout,
  getSubmenuLayout,
  isSubmenuHeightClipped,
  toViewportTrigger,
  type DropdownAlignment,
} from './dropdownPosition';

interface UseDropdownPositionOptions {
  buttonRef: RefObject<HTMLElement | null>;
  dropdownRef?: RefObject<HTMLElement | null>;
  preferredAlignment?: DropdownAlignment;
  minWidth?: number;
  maxWidth?: number;
  submenuMaxHeight?: number;
  submenuBottomClearance?: number;
  submenu?: boolean;
}

interface PositionState {
  left?: number;
  top?: number;
  bottom?: number;
  maxHeight?: number;
  maxWidth?: number;
  submenuSide?: 'right' | 'left';
  submenuOverlap?: number;
}

const FALLBACK_ABSOLUTE_LEFT: CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  left: 0,
  ['--selector-enter-x' as string]: '0px',
  ['--selector-enter-y' as string]: '6px',
};

const FALLBACK_ABSOLUTE_RIGHT: CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  right: 0,
  ['--selector-enter-x' as string]: '0px',
  ['--selector-enter-y' as string]: '6px',
};

const FALLBACK_SUBMENU_RIGHT: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: '100%',
  zIndex: 10001,
  ['--selector-enter-x' as string]: '-8px',
  ['--selector-enter-y' as string]: '0px',
};

export function useDropdownPosition({
  buttonRef,
  dropdownRef,
  preferredAlignment = 'left',
  minWidth = 200,
  maxWidth = 360,
  submenuMaxHeight = 300,
  submenuBottomClearance = 96,
  submenu = false,
}: UseDropdownPositionOptions): {
  positionedStyle: CSSProperties;
  maxHeight: number | undefined;
  maxWidth: number | undefined;
  recalculate: () => void;
} {
  const [positionState, setPositionState] = useState<PositionState | null>(null);

  const recalculate = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const viewport = getAppViewport();
    const trigger = toViewportTrigger(rect, viewport);
    const dropdown = dropdownRef?.current;

    if (submenu) {
      const measuredWidth = dropdown
        ? Math.max(dropdown.getBoundingClientRect().width, dropdown.scrollWidth)
        : minWidth;
      const measuredHeight = dropdown
        ? Math.max(dropdown.getBoundingClientRect().height, dropdown.scrollHeight)
        : submenuMaxHeight;
      const layout = getSubmenuLayout({
        trigger,
        viewport,
        measuredWidth,
        measuredHeight,
        minWidth,
        maxWidth,
        maxHeight: submenuMaxHeight,
        bottomClearance: submenuBottomClearance,
      });
      const reportedMaxHeight = isSubmenuHeightClipped(layout.maxHeight, measuredHeight)
        ? layout.maxHeight
        : undefined;

      setPositionState((current) => {
        if (
          current
          && current.top === layout.topOffset
          && current.maxHeight === reportedMaxHeight
          && current.maxWidth === layout.maxWidth
          && current.submenuSide === layout.side
          && current.submenuOverlap === layout.overlap
        ) {
          return current;
        }
        return {
          top: layout.topOffset,
          maxHeight: reportedMaxHeight,
          maxWidth: layout.maxWidth,
          submenuSide: layout.side,
          submenuOverlap: layout.overlap,
        };
      });
      return;
    }

    const measuredWidth = dropdown ? dropdown.getBoundingClientRect().width : minWidth;
    const layout = getMainDropdownLayout({
      trigger,
      viewport,
      measuredWidth,
      minWidth,
      preferredAlignment,
    });

    setPositionState((current) => {
      if (
        current
        && current.left === layout.left
        && current.bottom === layout.bottom
        && current.maxHeight === layout.maxHeight
      ) {
        return current;
      }
      return {
        left: layout.left,
        bottom: layout.bottom,
        maxHeight: layout.maxHeight,
        submenuSide: 'right',
      };
    });
  }, [buttonRef, dropdownRef, preferredAlignment, minWidth, maxWidth, submenu, submenuBottomClearance, submenuMaxHeight]);

  if (!positionState) {
    if (submenu) {
      return { positionedStyle: FALLBACK_SUBMENU_RIGHT, maxHeight: undefined, maxWidth: undefined, recalculate };
    }
    return {
      positionedStyle: preferredAlignment === 'left' ? FALLBACK_ABSOLUTE_LEFT : FALLBACK_ABSOLUTE_RIGHT,
      maxHeight: undefined,
      maxWidth: undefined,
      recalculate,
    };
  }

  if (submenu) {
    const sideStyle: CSSProperties = positionState.submenuSide === 'left'
      ? { right: '100%', marginRight: `-${positionState.submenuOverlap ?? 0}px` }
      : { left: '100%', marginLeft: `-${positionState.submenuOverlap ?? 0}px` };

    return {
      positionedStyle: {
        position: 'absolute',
        top: positionState.top,
        ...sideStyle,
        maxWidth: positionState.maxWidth,
        minWidth: 0,
        zIndex: 10001,
        ['--selector-enter-x' as string]: positionState.submenuSide === 'left' ? '8px' : '-8px',
        ['--selector-enter-y' as string]: '0px',
      },
      maxHeight: positionState.maxHeight,
      maxWidth: positionState.maxWidth,
      recalculate,
    };
  }

  const { fixedPosDivisor } = getAppViewport();
  return {
    positionedStyle: {
      position: 'fixed',
      left: (positionState.left ?? 0) / fixedPosDivisor,
      bottom: (positionState.bottom ?? 0) / fixedPosDivisor,
      zIndex: 10000,
      ['--selector-enter-x' as string]: '0px',
      ['--selector-enter-y' as string]: '6px',
    },
    maxHeight: (positionState.maxHeight ?? 0) / fixedPosDivisor,
    maxWidth: undefined,
    recalculate,
  };
}
