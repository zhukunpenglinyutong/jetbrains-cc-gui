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
 * Dropdown - 通用下拉菜单组件
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
  // selectedIndex 用于父组件传递，当前组件不直接使用
  void _selectedIndex;
  const dropdownRef = useRef<HTMLDivElement>(null);

  /**
   * 点击外部关闭
   */
  useEffect(() => {
    if (!isVisible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose?.();
      }
    };

    // 延迟添加事件监听，避免立即触发
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
 * CompletionDropdown - 补全专用下拉菜单
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
   * 滚动高亮项到可见区域
   */
  useEffect(() => {
    if (!listRef.current) return;

    const activeItem = listRef.current.querySelector('.dropdown-item.active');
    if (activeItem) {
      // 使用 'auto' 瞬间滚动，避免平滑动画导致的延迟
      activeItem.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }, [selectedIndex]);

  /**
   * 处理选择
   */
  const handleSelect = useCallback((item: DropdownItemData, index: number) => {
    // 允许选择所有类型（文件和目录）
    onSelect?.(item, index);
  }, [onSelect]);

  /**
   * 处理鼠标进入
   */
  const handleMouseEnter = useCallback((index: number) => {
    onMouseEnter?.(index);
  }, [onMouseEnter]);

  // 过滤可选择的项（排除分隔线和标题）
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
            // 计算在可选择项中的索引
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
