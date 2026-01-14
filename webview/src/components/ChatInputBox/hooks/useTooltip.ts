import { useCallback, useState } from 'react';

export interface TooltipState {
  visible: boolean;
  text: string;
  top: number;
  left: number;
  tx?: string; // transform-x value
  arrowLeft?: string; // arrow left position
  width?: number; // width of the tooltip
  isBar?: boolean; // whether to show as a bar
}

interface UseTooltipReturn {
  /** Current tooltip state */
  tooltip: TooltipState | null;
  /** Handle mouse over to show tooltip */
  handleMouseOver: (e: React.MouseEvent) => void;
  /** Handle mouse leave to hide tooltip */
  handleMouseLeave: () => void;
}

/**
 * useTooltip - Manage tooltip state for file tags
 *
 * Shows a floating tooltip when hovering over file tags,
 * with smart positioning to avoid viewport overflow.
 */
export function useTooltip(): UseTooltipReturn {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  /**
   * Handle mouse over to show tooltip (small floating popup style)
   */
  const handleMouseOver = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const fileTag = target.closest('.file-tag.has-tooltip');

    if (fileTag) {
      const text = fileTag.getAttribute('data-tooltip');
      if (text) {
        // Use small floating tooltip (same effect as context-item)
        const rect = fileTag.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const tagCenterX = rect.left + rect.width / 2; // File tag center X coordinate

        // Estimate tooltip width (based on text length)
        const estimatedTooltipWidth = Math.min(text.length * 7 + 24, 400);
        const tooltipHalfWidth = estimatedTooltipWidth / 2;

        let tooltipLeft = tagCenterX; // Tooltip base point (default centered)
        let tx = '-50%'; // Tooltip horizontal offset (default centered)
        let arrowLeft = '50%'; // Arrow position (relative to tooltip, default middle)

        // Boundary detection: prevent tooltip left overflow
        if (tagCenterX - tooltipHalfWidth < 10) {
          // Near left edge: tooltip left-aligned
          tooltipLeft = 10; // Tooltip left edge 10px from viewport
          tx = '0'; // Tooltip no offset
          arrowLeft = `${tagCenterX - 10}px`; // Arrow points to file tag center
        }
        // Boundary detection: prevent tooltip right overflow
        else if (tagCenterX + tooltipHalfWidth > viewportWidth - 10) {
          // Near right edge: tooltip right-aligned
          tooltipLeft = viewportWidth - 10; // Tooltip right edge 10px from viewport
          tx = '-100%'; // Tooltip offset left by full width
          arrowLeft = `${tagCenterX - (viewportWidth - 10) + estimatedTooltipWidth}px`; // Arrow points to file tag center
        }
        // Normal case: tooltip centered
        else {
          arrowLeft = '50%'; // Arrow in tooltip middle
        }

        setTooltip({
          visible: true,
          text,
          top: rect.top,
          left: tooltipLeft,
          tx,
          arrowLeft,
          isBar: false,
        });
      }
    } else {
      setTooltip(null);
    }
  }, []);

  /**
   * Handle mouse leave to hide tooltip
   */
  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  return {
    tooltip,
    handleMouseOver,
    handleMouseLeave,
  };
}
