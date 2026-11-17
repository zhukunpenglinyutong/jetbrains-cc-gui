import { getAppViewport } from '../../../utils/viewport.js';

/**
 * Keep the contenteditable caret inside its scrolling wrapper after an edit.
 * The wrapper owns scrolling, so scrolling the editable element itself would
 * not reveal a caret near the top or bottom of a long draft.
 */
export function scrollCaretIntoView(editable: HTMLElement | null): void {
  if (!editable) return;

  const selection = window.getSelection();
  const focusNode = selection?.focusNode;
  if (!selection || selection.rangeCount === 0 || !focusNode || !editable.contains(focusNode)) {
    return;
  }

  const wrapper = editable.parentElement;
  if (!wrapper) return;

  const caretRange = document.createRange();
  caretRange.setStart(focusNode, selection.focusOffset);
  caretRange.collapse(true);

  let clientRects = caretRange.getClientRects();
  let caretRect = clientRects[clientRects.length - 1];
  if (!caretRect && focusNode.nodeType === Node.ELEMENT_NODE) {
    // Chromium returns no collapsed rect on blank lines and between elements.
    // Measure the adjacent node rather than mistaking an all-zero rect for the caret.
    const next = focusNode.childNodes[selection.focusOffset];
    const adjacent = next ?? focusNode.childNodes[selection.focusOffset - 1];
    if (adjacent) {
      caretRange.selectNode(adjacent);
      clientRects = caretRange.getClientRects();
      caretRect = next ? clientRects[0] : clientRects[clientRects.length - 1];
    }
  }
  if (!caretRect) return;

  const wrapperRect = wrapper.getBoundingClientRect();
  const { fixedPosDivisor: scale } = getAppViewport();
  const style = getComputedStyle(wrapper);
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  // Range rects follow app zoom, but client dimensions and scrollTop use logical
  // pixels. Keep the wrapper's padding clear so the caret stays above the toolbar.
  const visibleTop = wrapperRect.top + (wrapper.clientTop + paddingTop) * scale;
  const visibleBottom = wrapperRect.top + (wrapper.clientTop + wrapper.clientHeight - paddingBottom) * scale;

  if (caretRect.top < visibleTop) {
    wrapper.scrollTop -= (visibleTop - caretRect.top) / scale;
  } else if (caretRect.bottom > visibleBottom) {
    wrapper.scrollTop += (caretRect.bottom - visibleBottom) / scale;
  }
}
