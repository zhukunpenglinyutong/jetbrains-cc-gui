import React from "react";
import { formatBucketRange } from "../../../lib/trend-stats";

// Owns the trend chart's hover tooltip state: which bar is hovered, where the
// tooltip floats (with edge-overflow and top-clip handling), the chart
// container ref used for relative positioning, and the debounced hide timer.
export function useTrendTooltip({ granularity, locale, isZoom }) {
  const [hoveredBar, setHoveredBar] = React.useState(null);
  const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0, shiftX: 0, flipDown: false });
  const containerRef = React.useRef(null);
  const hideTimeoutRef = React.useRef(null);

  // 卸载时回收防抖定时器
  React.useEffect(() => {
    return () => {
      clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  const handleBarMouseEnter = React.useCallback((e, row, value, segments, kind, displayValue) => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    const timeLabel = formatBucketRange(row, granularity, locale);
    setHoveredBar({
      row,
      value,
      segments,
      timeLabel,
      kind,
      displayValue,
    });

    // 优先寻找真实柱状图定位，以防外层 hover 容器导致 top 坐标上移
    // 注意：data-trend-bar="true" 绑定在子级 segment 上，它的 parentElement 才是整根柱子的实体容器包装 div
    const barEl = e.currentTarget.querySelector('[data-trend-bar="true"]');
    const rect = barEl && barEl.parentElement
      ? barEl.parentElement.getBoundingClientRect()
      : e.currentTarget.getBoundingClientRect();
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const x = rect.left - containerRect.left + rect.width / 2;
    const y = rect.top - containerRect.top;

    // 自适应横向防溢出
    const halfWidth = 140;
    let shiftX = 0;
    if (x < halfWidth) {
      shiftX = halfWidth - x;
    } else if (x > containerRect.width - halfWidth) {
      shiftX = (containerRect.width - halfWidth) - x;
    }

    // Flip the tooltip below the bar when there isn't room above it. Tall zoom
    // bars sit near the top of the chart, so an upward tooltip would be clipped
    // by the chart container. `y` is the bar top relative to the container top.
    const estTooltipHeight =
      96 + (isZoom ? 22 : 0) + (segments.length ? Math.min(segments.length * 30 + 24, 174) : 0);
    const flipDown = y < estTooltipHeight + 12;

    setTooltipPos({ x, y, shiftX, flipDown });
  }, [isZoom, granularity, locale]);

  const handleBarMouseLeave = React.useCallback(() => {
    clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setHoveredBar(null);
    }, 150);
  }, []);

  return { hoveredBar, tooltipPos, containerRef, handleBarMouseEnter, handleBarMouseLeave };
}
