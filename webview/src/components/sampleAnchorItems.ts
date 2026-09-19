export interface AnchorItem {
  id: string;
  position: number;
  preview: string;
}

const MAX_ANCHOR_COUNT = 30;

export function sampleAnchorItems(items: AnchorItem[], maxCount = MAX_ANCHOR_COUNT): AnchorItem[] {
  if (items.length <= maxCount || maxCount < 2) {
    return items;
  }
  return Array.from({ length: maxCount }, (_, index) => {
    const sourceIndex = Math.round((index / (maxCount - 1)) * (items.length - 1));
    return items[sourceIndex];
  });
}
