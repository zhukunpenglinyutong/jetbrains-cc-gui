import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DropdownProps, DropdownItemData } from '../types';
import { DropdownItem } from './DropdownItem';
import { getAppViewport } from '../../../utils/viewport';

interface CompletionDropdownProps extends Omit<DropdownProps, 'children'> {
  items: DropdownItemData[];
  loading?: boolean;
  emptyText?: string;
  onSelect?: (item: DropdownItemData, index: number) => void;
  onMouseEnter?: (index: number) => void;
}

/**
 * Dropdown - Generic dropdown menu component
 */
export const Dropdown = ({
  isVisible,
  position,
  width = 300,
  offsetY = 4,
  offsetX = 0,
  selectedIndex: _selectedIndex = 0,
  onClose,
  children,
}: DropdownProps) => {
  // selectedIndex is passed from parent component, not directly used here
  void _selectedIndex;
  const dropdownRef = useRef<HTMLDivElement>(null);

  /**
   * Close on outside click
   */
  useEffect(() => {
    if (!isVisible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose?.();
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
  }, [isVisible]); // Remove onClose from dependencies - it's stable from props

  if (!isVisible || !position) {
    return null;
  }

  // Use #app's bounding rect as the reference viewport.
  // Both #app's rect and position (from getBoundingClientRect on child elements)
  // are in the same coordinate space, so they can be safely compared regardless
  // of the zoom factor applied to #app.
  const { width: viewportWidth, height: viewportHeight, top: viewportTop, left: viewportLeft, fixedPosDivisor } = getAppViewport();

  // Calculate left position, ensure it doesn't exceed viewport right edge
  let left = position.left - viewportLeft + offsetX;
  const edgePadding = 10;

  if (left + width + edgePadding > viewportWidth) {
    left = viewportWidth - width - edgePadding;
  }

  // Ensure it doesn't exceed viewport left edge
  if (left < edgePadding) {
    left = edgePadding;
  }

  // Display above cursor: use bottom positioning
  // position.top is relative to viewport; convert to relative to #app bottom
  const posInApp = position.top - viewportTop;
  const effectiveTop = Math.max(offsetY, Math.min(posInApp, viewportHeight - offsetY));
  const bottomValue = viewportHeight - effectiveTop + offsetY;

  const style: React.CSSProperties = {
    position: 'fixed',
    bottom: `${bottomValue / fixedPosDivisor}px`,
    left: left / fixedPosDivisor,
    width,
    zIndex: 1001,
  };

  return (
    <div
      ref={dropdownRef}
      className="completion-dropdown"
      style={style}
    >
      {children}
    </div>
  );
};

/**
 * CompletionDropdown - Completion-specific dropdown menu
 */
export const CompletionDropdown = ({
  isVisible,
  position,
  width = 300,
  offsetY = 4,
  offsetX = 0,
  selectedIndex = 0,
  items,
  loading = false,
  emptyText,
  onClose,
  onSelect,
  onMouseEnter,
}: CompletionDropdownProps) => {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Scroll highlighted item into view
   */
  useEffect(() => {
    if (!listRef.current) return;

    const activeItem = listRef.current.querySelector('.dropdown-item.active');
    if (activeItem) {
      // Use 'auto' for instant scroll to avoid smooth animation delay
      activeItem.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }, [selectedIndex]);

  /**
   * Handle selection
   */
  const handleSelect = useCallback((item: DropdownItemData, index: number) => {
    // Allow selecting all types (files and directories)
    onSelect?.(item, index);
  }, [onSelect]);

  /**
   * Handle mouse enter
   */
  const handleMouseEnter = useCallback((index: number) => {
    onMouseEnter?.(index);
  }, [onMouseEnter]);

  // Filter selectable items (exclude separators and section headers)
  const selectableItems = items.filter(
    item => item.type !== 'separator' && item.type !== 'section-header'
  );

  return (
    <Dropdown
      isVisible={isVisible}
      position={position}
      width={width}
      offsetY={offsetY}
      offsetX={offsetX}
      selectedIndex={selectedIndex}
      onClose={onClose}
    >
      <div ref={listRef}>
        {loading ? (
          <div className="dropdown-loading">{t('chat.loadingDropdown')}</div>
        ) : items.length === 0 ? (
          <div className="dropdown-empty">{emptyText || t('chat.loadingDropdown')}</div>
        ) : (
          items.map((item) => {
            // Calculate index within selectable items
            const selectableIndex = selectableItems.findIndex(i => i.id === item.id);
            const isActive = selectableIndex === selectedIndex;

            return (
              <DropdownItem
                key={item.id}
                item={item}
                isActive={isActive}
                onClick={() => handleSelect(item, selectableIndex)}
                onMouseEnter={() => {
                  if (item.type !== 'separator' && item.type !== 'section-header') {
                    handleMouseEnter(selectableIndex);
                  }
                }}
              />
            );
          })
        )}
      </div>
    </Dropdown>
  );
};

export { DropdownItem };
export default Dropdown;
