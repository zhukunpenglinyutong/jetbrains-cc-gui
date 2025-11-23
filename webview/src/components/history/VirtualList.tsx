import type { ReactNode, UIEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  height: number;
  overscanCount?: number;
  renderItem: (item: T, index: number) => ReactNode;
  getItemKey?: (item: T, index: number) => React.Key;
  className?: string;
}

const VirtualList = <T,>({
  items,
  itemHeight,
  height,
  overscanCount = 3,
  renderItem,
  getItemKey,
  className,
}: VirtualListProps<T>) => {
  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef<number | null>(null);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      setScrollTop(target.scrollTop);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const { startIndex, visibleItems, offsetY } = useMemo(() => {
    const visibleStartIndex = Math.floor(scrollTop / itemHeight);
    const visibleEndIndex = Math.ceil((scrollTop + height) / itemHeight);

    const start = Math.max(0, visibleStartIndex - overscanCount);
    const end = Math.min(items.length - 1, visibleEndIndex + overscanCount);

    return {
      startIndex: start,
      visibleItems: items.slice(start, end + 1),
      offsetY: start * itemHeight,
    };
  }, [height, itemHeight, items, overscanCount, scrollTop]);

  const totalHeight = items.length * itemHeight;

  return (
    <div
      className={className}
      onScroll={handleScroll}
      style={{ overflowY: 'auto', height }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div
          style={{
            transform: `translateY(${offsetY}px)`,
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            willChange: scrollTop > 0 ? 'transform' : undefined,
          }}
        >
          {visibleItems.map((item, index) => {
            const actualIndex = startIndex + index;
            const key =
              getItemKey?.(item, actualIndex) ?? (item as { sessionId?: string })?.sessionId ?? actualIndex;

            return (
              <div key={key} style={{ height: itemHeight }}>
                {renderItem(item, actualIndex)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default VirtualList;

