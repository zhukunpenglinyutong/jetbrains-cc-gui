export interface PreviewSelection {
  start: number;
  end: number;
  selectedText: string;
  positionAttribute: string;
  left: number;
  top: number;
}

export function positionAttribute(): string | null {
  const value = document.querySelector<HTMLMetaElement>('meta[name="markdown-position-attribute-name"]')?.content;
  return value && /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

export function sourceRange(element: Element, attribute: string): [number, number] | null {
  const match = /^(\d+)\.\.(\d+)$/.exec(element.getAttribute(attribute) ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return end > start ? [start, end] : null;
}

export function capturePreviewSelection(root: HTMLElement): PreviewSelection | null {
  const attribute = positionAttribute();
  // Chromium's document selection may rescope a shadow selection to its host.
  const shadows = Array.from(root.querySelectorAll('.mermaid-diagram')).map(host => host.shadowRoot);
  const selection = shadows.map(shadow => (shadow as ShadowRoot & { getSelection?: () => Selection | null })?.getSelection?.())
    .find(value => value && !value.isCollapsed) ?? window.getSelection();
  if (!attribute || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const hostNode = (node: Node): Node => {
    const tree = node.getRootNode();
    return tree instanceof ShadowRoot ? hostNode(tree.host) : node;
  };
  if (!root.contains(hostNode(range.startContainer)) || !root.contains(hostNode(range.endContainer))) return null;
  const selectedText = range.toString();
  if (!selectedText.trim() || selectedText.length > 32_000) return null;
  const nearest = (node: Node): [number, number] | null => {
    let element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    while (element && root.contains(hostNode(element))) {
      const offsets = sourceRange(element, attribute);
      if (offsets) return offsets;
      if (element.matches('.mermaid-diagram, .mermaid[data-actual-fence-content]')) return null;
      // Some diagram renderers insert SVG beside the positioned code node.
      // Only accept a single local code anchor, never an arbitrary document range.
      if (element !== root && element.querySelector('svg')) {
        const anchors = element.querySelectorAll('pre[' + attribute + '], code[' + attribute + ']');
        if (anchors.length === 1) return sourceRange(anchors[0], attribute);
      }
      const tree = element.getRootNode();
      element = element.parentElement ?? (tree instanceof ShadowRoot ? tree.host : null);
    }
    return null;
  };
  const from = nearest(range.startContainer);
  const to = nearest(range.endContainer);
  if (!from || !to) return null;
  const rect = range.getBoundingClientRect();
  return {
    start: Math.min(from[0], to[0]), end: Math.max(from[1], to[1]),
    selectedText, positionAttribute: attribute, left: rect.left, top: rect.bottom,
  };
}

/** The native source range provides a block anchor, not a rendered-text offset. */
export function findSourceElement(root: HTMLElement, start: number, end: number): Element | null {
  const attribute = positionAttribute();
  if (!attribute) return null;
  return Array.from(root.querySelectorAll('[' + attribute + ']'))
    .filter(element => {
      const range = sourceRange(element, attribute);
      return range && range[0] <= start && range[1] >= end;
    })
    .sort((a, b) => {
      const ar = sourceRange(a, attribute)!;
      const br = sourceRange(b, attribute)!;
      return (ar[1] - ar[0]) - (br[1] - br[0]);
    })[0] ?? null;
}

/** Draw the visible quotation only when it is unique inside the native block. */
export function quoteRects(element: Element, selectedText: string): DOMRect[] {
  const walker = document.createTreeWalker(element.shadowRoot?.querySelector('.mermaid-zoom-content svg')
    ?? element.shadowRoot?.querySelector('svg') ?? element, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest('style, script, [hidden], defs, title, desc')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  const text = nodes.map(item => item.data).join('');
  const start = text.indexOf(selectedText);
  if (!selectedText || start < 0 || text.indexOf(selectedText, start + 1) >= 0) return [];
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const item of nodes) {
    if (!started && start < offset + item.length) {
      range.setStart(item, start - offset); started = true;
    }
    if (started && start + selectedText.length <= offset + item.length) {
      range.setEnd(item, start + selectedText.length - offset);
      return Array.from(range.getClientRects());
    }
    offset += item.length;
  }
  return [];
}
