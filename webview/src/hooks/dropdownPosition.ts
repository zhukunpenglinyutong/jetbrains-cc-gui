export type DropdownAlignment = 'left' | 'right';
export type SubmenuSide = 'left' | 'right';

export interface ViewportBox {
  width: number;
  height: number;
  left: number;
  top: number;
}

export interface TriggerBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SubmenuLayout {
  topOffset: number;
  maxHeight: number;
  maxWidth: number;
  side: SubmenuSide;
  overlap: number;
}

export interface SubmenuLayoutInput {
  trigger: TriggerBox;
  viewport: ViewportBox;
  measuredWidth?: number;
  measuredHeight?: number;
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  padding?: number;
  gap?: number;
  bottomClearance?: number;
}

const DEFAULT_PADDING = 8;
const DEFAULT_GAP = 4;
const DEFAULT_MIN_WIDTH = 200;
const DEFAULT_MAX_WIDTH = 360;
const DEFAULT_MAX_HEIGHT = 300;
const DEFAULT_BOTTOM_CLEARANCE = 96;
/** Border-box / subpixel slack so a menu that fits does not grow a phantom scrollbar. */
const SUBMENU_HEIGHT_CLIP_SLACK_PX = 2;

export function isSubmenuHeightClipped(constrainedHeight: number, measuredHeight: number): boolean {
  return constrainedHeight + SUBMENU_HEIGHT_CLIP_SLACK_PX < measuredHeight;
}

export function toViewportTrigger(rect: DOMRect, viewport: ViewportBox): TriggerBox {
  return {
    left: rect.left - viewport.left,
    right: rect.right - viewport.left,
    top: rect.top - viewport.top,
    bottom: rect.bottom - viewport.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Place a fly-out submenu next to its trigger, preferring the side with more
 * room. Overlap is computed from the measured width so a wide model list can
 * sit on top of the parent menu instead of being clipped by the plugin edge.
 */
export function getSubmenuLayout({
  trigger,
  viewport,
  measuredWidth,
  measuredHeight,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  maxHeight = DEFAULT_MAX_HEIGHT,
  padding = DEFAULT_PADDING,
  bottomClearance = DEFAULT_BOTTOM_CLEARANCE,
}: SubmenuLayoutInput): SubmenuLayout {
  const availableRight = Math.max(0, viewport.width - padding - trigger.right);
  const availableLeft = Math.max(0, trigger.left - padding);
  const side: SubmenuSide = availableRight >= minWidth
    ? 'right'
    : availableLeft >= minWidth
      ? 'left'
      : availableRight >= availableLeft ? 'right' : 'left';
  const availableSideWidth = side === 'right' ? availableRight : availableLeft;
  const desiredWidth = Math.min(
    maxWidth,
    Math.max(minWidth, measuredWidth ?? minWidth),
  );
  const constrainedWidth = Math.max(1, Math.min(desiredWidth, viewport.width - padding * 2));
  const overlap = Math.max(0, constrainedWidth - availableSideWidth);

  const desiredHeight = Math.min(maxHeight, Math.max(1, measuredHeight ?? maxHeight));
  const availableBelow = viewport.height - padding - trigger.top;
  const minTopOffset = padding - trigger.top;
  const topOffset = Math.max(
    minTopOffset,
    Math.min(0, availableBelow - desiredHeight - bottomClearance),
  );
  const availableHeight = viewport.height - padding - trigger.top - topOffset;
  const constrainedHeight = Math.max(1, Math.min(desiredHeight, availableHeight));

  return {
    topOffset,
    maxHeight: constrainedHeight,
    maxWidth: constrainedWidth,
    side,
    overlap,
  };
}

export function getMainDropdownLayout({
  trigger,
  viewport,
  measuredWidth,
  minWidth = DEFAULT_MIN_WIDTH,
  preferredAlignment = 'left',
  padding = DEFAULT_PADDING,
  gap = DEFAULT_GAP,
}: {
  trigger: TriggerBox;
  viewport: ViewportBox;
  measuredWidth?: number;
  minWidth?: number;
  preferredAlignment?: DropdownAlignment;
  padding?: number;
  gap?: number;
}): { left: number; bottom: number; maxHeight: number } {
  const dropdownWidth = Math.min(
    Math.max(minWidth, measuredWidth ?? minWidth),
    viewport.width - (padding * 2),
  );
  const leftAlignedLeft = trigger.left;
  const rightAlignedLeft = trigger.right - dropdownWidth;
  let left: number;
  if (preferredAlignment === 'right') {
    left = rightAlignedLeft >= padding ? rightAlignedLeft : leftAlignedLeft;
  } else {
    left = leftAlignedLeft + dropdownWidth + padding <= viewport.width ? leftAlignedLeft : rightAlignedLeft;
  }
  left = Math.max(padding, Math.min(left, viewport.width - dropdownWidth - padding));

  return {
    left,
    bottom: viewport.height - trigger.top + gap,
    maxHeight: Math.max(1, trigger.top - gap - padding),
  };
}
