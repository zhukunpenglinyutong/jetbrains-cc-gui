const DROPDOWN_SIDE_OVERLAP_PX = 30;
const DROPDOWN_VIEWPORT_PADDING_PX = 8;
const DROPDOWN_MIN_FLUSH_WIDTH_PX = 180;
export const DROPDOWN_MAX_WIDTH_PX = 360;
export const DROPDOWN_MAX_HEIGHT_PX = 380;
const DROPDOWN_BOTTOM_CLEARANCE_PX = 72;

export interface EmbeddedNodeProcessDropdownLayout {
  flipToLeft: boolean;
  maxWidth: number;
  maxHeight: number;
  topOffset: number;
  horizontalOverlap: number;
}

export interface EmbeddedNodeProcessDropdownLayoutInput {
  parentRect: { left: number; right: number; top: number };
  viewportWidth: number;
  viewportHeight: number;
  dropdownHeight: number;
}

export function getEmbeddedNodeProcessDropdownLayout({
  parentRect,
  viewportWidth,
  viewportHeight,
  dropdownHeight,
}: EmbeddedNodeProcessDropdownLayoutInput): EmbeddedNodeProcessDropdownLayout {
  const normalAvailableWidth = Math.max(
    0,
    viewportWidth - DROPDOWN_VIEWPORT_PADDING_PX - parentRect.right,
  );
  const flippedAvailableWidth = Math.max(
    0,
    parentRect.left - DROPDOWN_VIEWPORT_PADDING_PX,
  );
  const normalShortfall = Math.max(0, DROPDOWN_MIN_FLUSH_WIDTH_PX - normalAvailableWidth);
  const flippedShortfall = Math.max(0, DROPDOWN_MIN_FLUSH_WIDTH_PX - flippedAvailableWidth);
  const flipToLeft = normalShortfall > 0 && flippedShortfall < normalShortfall;
  const availableWidthWithoutOverlap = flipToLeft ? flippedAvailableWidth : normalAvailableWidth;
  const horizontalOverlap = Math.min(
    DROPDOWN_SIDE_OVERLAP_PX,
    Math.max(0, DROPDOWN_MIN_FLUSH_WIDTH_PX - availableWidthWithoutOverlap),
  );
  const availableWidth = availableWidthWithoutOverlap + horizontalOverlap;
  const desiredHeight = Math.min(DROPDOWN_MAX_HEIGHT_PX, Math.max(1, Math.ceil(dropdownHeight)));
  const availableBelow = viewportHeight - DROPDOWN_VIEWPORT_PADDING_PX - parentRect.top;
  const minTopOffset = DROPDOWN_VIEWPORT_PADDING_PX - parentRect.top;
  const topOffset = Math.max(
    minTopOffset,
    Math.min(0, availableBelow - desiredHeight - DROPDOWN_BOTTOM_CLEARANCE_PX),
  );
  const availableHeight = viewportHeight - DROPDOWN_VIEWPORT_PADDING_PX - parentRect.top - topOffset;

  return {
    flipToLeft,
    maxWidth: Math.max(1, Math.min(DROPDOWN_MAX_WIDTH_PX, Math.floor(availableWidth))),
    maxHeight: Math.max(1, Math.min(DROPDOWN_MAX_HEIGHT_PX, Math.floor(availableHeight))),
    topOffset,
    horizontalOverlap,
  };
}
