import { useEffect, useRef, useState } from "react";

// 2D 精致 Hover 状态：tracks the hovered grid cell plus the viewport-fixed
// tooltip position, with a debounced hide so the tooltip doesn't flicker.
export function useHeatmapTooltip(scrollRef) {
  const [hoveredCell, setHoveredCell] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0, shiftX: 0, flipY: false });
  const hideTimeoutRef = useRef(null);

  // 卸载时回收防抖定时器
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      setHoveredCell(null);
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  const handleCellMouseEnter = (e, cell) => {
    if (!cell || !cell.day) return;
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setHoveredCell(cell);

    // Tooltip is portaled to document.body with position: fixed, so use viewport
    // coordinates directly. This keeps it visible inside the leaderboard
    // profile modal, where the Dialog.Popup has both `overflow-hidden` and
    // a `transform` (from the open/close transition) — that combo clips any
    // absolute-positioned tooltip rendered inside the modal subtree.
    const rect = e.currentTarget.getBoundingClientRect();
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
    const x = rect.left + rect.width / 2;

    // Flip below the cell when there isn't room above (cells near the viewport
    // top would clip the tooltip); 300px covers the tallest tooltip variant.
    const flipY = rect.top < 300;
    const y = flipY ? rect.bottom : rect.top;

    const halfWidth = 140;
    let shiftX = 0;
    if (x < halfWidth) {
      shiftX = halfWidth - x;
    } else if (x > viewportWidth - halfWidth) {
      shiftX = (viewportWidth - halfWidth) - x;
    }

    setTooltipPos({ x, y, shiftX, flipY });
  };

  const handleCellMouseLeave = () => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setHoveredCell(null);
    }, 150);
  };

  return { hoveredCell, tooltipPos, handleCellMouseEnter, handleCellMouseLeave };
}
