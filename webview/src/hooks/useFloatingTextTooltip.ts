import { useCallback, useEffect, useRef } from 'react';

export interface FloatingTextTooltipController {
  showTooltip: (text: string, clientX: number, clientY: number) => HTMLDivElement | null;
  moveTooltip: (text: string, clientX: number, clientY: number) => void;
  hideTooltip: () => void;
}

function updateTooltipPosition(
  tooltip: HTMLDivElement,
  clientX: number,
  clientY: number,
): void {
  // Measure actual tooltip width after it's been added to DOM
  const tooltipRect = tooltip.getBoundingClientRect();
  const tooltipWidth = tooltipRect.width;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;

  let safeX = clientX + 12;
  let transform = 'translateY(-100%)';

  if (safeX + tooltipWidth > viewportWidth - 8) {
    safeX = clientX - 12;
    transform = 'translateY(-100%) translateX(-100%)';
  }

  if (transform.includes('translateX(-100%)')) {
    safeX = Math.max(tooltipWidth + 8, Math.min(safeX, viewportWidth - 8));
  } else {
    safeX = Math.max(8, Math.min(safeX, viewportWidth - 8 - tooltipWidth));
  }

  const safeY = clientY - 8;

  tooltip.style.left = `${safeX}px`;
  tooltip.style.top = `${safeY}px`;
  tooltip.style.transform = transform;
}

export function useFloatingTextTooltip(): FloatingTextTooltipController {
  const tooltipElRef = useRef<HTMLDivElement | null>(null);

  const hideTooltip = useCallback(() => {
    if (tooltipElRef.current) {
      tooltipElRef.current.remove();
      tooltipElRef.current = null;
    }
  }, []);

  const showTooltip = useCallback((text: string, clientX: number, clientY: number) => {
    if (!text) return null;

    hideTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = 'file-link-tooltip';
    tooltip.textContent = text;
    document.body.appendChild(tooltip);
    updateTooltipPosition(tooltip, clientX, clientY);
    tooltipElRef.current = tooltip;
    return tooltip;
  }, [hideTooltip]);

  const moveTooltip = useCallback((text: string, clientX: number, clientY: number) => {
    if (!tooltipElRef.current || !text) return;
    updateTooltipPosition(tooltipElRef.current, clientX, clientY);
  }, []);

  useEffect(() => hideTooltip, [hideTooltip]);

  return { showTooltip, moveTooltip, hideTooltip };
}
