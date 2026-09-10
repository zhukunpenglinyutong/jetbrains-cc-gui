import { useCallback, useEffect, useLayoutEffect } from 'react';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { togglePinnedModelId } from '../modelSelectUtils';

const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
  overflowX: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};
/** Cap model dropdown height so long lists scroll instead of filling the panel. */
const DROPDOWN_MAX_HEIGHT_PX = 300;

interface UseModelDropdownLayoutArgs {
  embedded: boolean;
  inline: boolean;
  isOpen: boolean;
  loading: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  filteredModelCount: number;
  pinnedCount: number;
}

/**
 * Positions the dropdown (fly-out or popover) and derives its final style.
 */
export function useModelDropdownLayout({
  embedded,
  inline,
  isOpen,
  loading,
  triggerRef,
  buttonRef,
  dropdownRef,
  filteredModelCount,
  pinnedCount,
}: UseModelDropdownLayoutArgs) {
  const { positionedStyle, maxHeight, maxWidth, recalculate } = useDropdownPosition({
    buttonRef: (embedded ? triggerRef : buttonRef) as React.RefObject<HTMLElement | null>,
    dropdownRef,
    preferredAlignment: 'right',
    submenu: embedded,
    minWidth: embedded ? 220 : 200,
    maxWidth: 360,
    submenuMaxHeight: DROPDOWN_MAX_HEIGHT_PX,
  });

  useLayoutEffect(() => {
    if (!inline && (embedded || isOpen)) {
      recalculate();
    }
  }, [embedded, inline, isOpen, filteredModelCount, pinnedCount, loading, recalculate]);

  const dropdownMaxHeight = maxHeight
    ? `${Math.min(DROPDOWN_MAX_HEIGHT_PX, maxHeight)}px`
    : `${DROPDOWN_MAX_HEIGHT_PX}px`;
  const dropdownStyle: React.CSSProperties = embedded
    ? {
        minWidth: 0,
        maxWidth: maxWidth ?? 360,
        maxHeight: dropdownMaxHeight,
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        ...positionedStyle,
      }
    : {
        ...DROPDOWN_STYLE,
        ...positionedStyle,
        maxHeight: dropdownMaxHeight,
      };

  return { dropdownStyle, recalculate };
}

interface UseModelSelectHandlersArgs {
  isOpen: boolean;
  inline: boolean;
  currentProvider: string;
  recalculate: () => void;
  onChange: (modelId: string) => void;
  onClose?: () => void;
  onAddModel?: () => void;
  setIsOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  setPinnedIds: (ids: string[]) => void;
}

/**
 * Click/select/pin handlers for ModelSelect, plus the shared close-and-reset.
 */
export function useModelSelectHandlers({
  isOpen,
  inline,
  currentProvider,
  recalculate,
  onChange,
  onClose,
  onAddModel,
  setIsOpen,
  setSearchQuery,
  setPinnedIds,
}: UseModelSelectHandlersArgs) {
  const resetSearchAndClose = useCallback(() => {
    setIsOpen(false);
    setSearchQuery('');
  }, [setIsOpen, setSearchQuery]);

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (!nextOpen) {
      setSearchQuery('');
    }
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate, setIsOpen, setSearchQuery]);

  /**
   * Select model
   */
  const handleSelect = useCallback((modelId: string) => {
    onChange(modelId);
    if (inline) return;
    resetSearchAndClose();
    onClose?.();
  }, [inline, onChange, onClose, resetSearchAndClose]);

  const handleTogglePin = useCallback((e: React.MouseEvent, modelId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setPinnedIds(togglePinnedModelId(currentProvider, modelId));
  }, [currentProvider, setPinnedIds]);

  const handleAddModel = useCallback(() => {
    onAddModel?.();
    resetSearchAndClose();
    onClose?.();
  }, [onAddModel, onClose, resetSearchAndClose]);

  return { handleToggle, handleSelect, handleTogglePin, handleAddModel, resetSearchAndClose };
}

const isOutsideDropdown = (
  target: Node,
  buttonRef: React.RefObject<HTMLButtonElement | null>,
  dropdownRef: React.RefObject<HTMLDivElement | null>,
): boolean => Boolean(
  dropdownRef.current
  && !dropdownRef.current.contains(target)
  && buttonRef.current
  && !buttonRef.current.contains(target),
);

interface UseModelSelectOutsideClickArgs {
  embedded: boolean;
  isOpen: boolean;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  resetSearchAndClose: () => void;
}

/**
 * Close on outside click
 */
export function useModelSelectOutsideClick({
  embedded,
  isOpen,
  buttonRef,
  dropdownRef,
  resetSearchAndClose,
}: UseModelSelectOutsideClickArgs) {
  useEffect(() => {
    if (embedded || !isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (isOutsideDropdown(e.target as Node, buttonRef, dropdownRef)) {
        resetSearchAndClose();
      }
    };

    // Delay adding event listener to prevent immediate trigger
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [embedded, isOpen, buttonRef, dropdownRef, resetSearchAndClose]);
}
