import { useCallback, useEffect, useRef } from 'react';

export interface FloatingTextTooltipController {
  showTooltip: (text: string, clientX: number, clientY: number) => HTMLDivElement | null;
  moveTooltip: (text: string, clientX: number, clientY: number) => void;
  hideTooltip: () => void;
}

function updateTooltipPosition(
  tooltip: HTMLDivElement,
  text: string,
  clientX: number,
  clientY: number,
): void {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const estimatedWidth = Math.min((text.length * 7) + 20, 400);

  let safeX = clientX + 12;
  let transform = 'translateY(-100%)';

  if (safeX + estimatedWidth > viewportWidth - 8) {
    safeX = clientX - 12;
    transform = 'translateY(-100%) translateX(-100%)';
  }

  if (transform.includes('translateX(-100%)')) {
    safeX = Math.max(estimatedWidth + 8, Math.min(safeX, viewportWidth - 8));
  } else {
    safeX = Math.max(8, Math.min(safeX, viewportWidth - 8 - estimatedWidth));
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
    tooltip.style.position = 'fixed';
    tooltip.style.pointerEvents = 'none';
    tooltip.textContent = text;
    updateTooltipPosition(tooltip, text, clientX, clientY);
    document.body.appendChild(tooltip);
    tooltipElRef.current = tooltip;
    return tooltip;
  }, [hideTooltip]);

  const moveTooltip = useCallback((text: string, clientX: number, clientY: number) => {
    if (!tooltipElRef.current || !text) return;
    updateTooltipPosition(tooltipElRef.current, text, clientX, clientY);
  }, []);

  useEffect(() => hideTooltip, [hideTooltip]);

  return { showTooltip, moveTooltip, hideTooltip };
}
