export interface DiagramRange { start: number; end: number; source: string }

const diagramSelector = '.mermaid[data-actual-fence-content], .mermaid-diagram[data-source]';

/** JetBrains stores the UTF-8 code fence as Base64; Visualizer stores plain text. */
export function diagramSource(host: Element): string | null {
  const encoded = host.getAttribute('data-actual-fence-content');
  if (encoded !== null) {
    if (encoded.length > 350_000) return null;
    try {
      return new TextDecoder('utf-8', { fatal: true })
        .decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0))).replace(/\r\n/g, '\n').trim();
    } catch { return null; }
  }
  return host.getAttribute('data-source')?.replace(/\r\n/g, '\n').trim() ?? null;
}

/** Keep both IDE-owned SVGs and Visualizer shadow SVGs on their original renderer/zoom. */
export function createMermaidAdapter(refresh: () => void, enabled: () => boolean) {
  const observed = new Map<ShadowRoot | HTMLElement, MutationObserver>();
  return (root: HTMLElement, attribute: string, diagrams: DiagramRange[]) => {
    const used = new Set<number>();
    for (const host of root.querySelectorAll<HTMLElement>(diagramSelector)) {
      const source = diagramSource(host);
      const index = diagrams.findIndex((diagram, i) => !used.has(i) && diagram.source === source);
      if (index >= 0) {
        used.add(index);
        host.setAttribute(attribute, `${diagrams[index].start}..${diagrams[index].end}`);
      } else host.removeAttribute(attribute);
      const surface = host.shadowRoot ?? host;
      if (!observed.has(surface)) {
        const isLabel = (event: Event) => event.target instanceof Element
          && !!event.target.closest('svg text, svg tspan, svg foreignObject')
          && !event.target.closest('a');
        // Both renderers pan on mousedown. Let label drags select text; drags
        // on the background still reach the renderer's pan handler.
        for (const type of ['mousedown', 'dblclick']) {
          surface.addEventListener(type, event => {
            if (enabled() && isLabel(event) && (event as MouseEvent).button === 0) event.stopPropagation();
          }, true);
        }
        const observer = new MutationObserver(refresh);
        observer.observe(surface, { subtree: true, childList: true, attributes: true,
          attributeFilter: ['style', 'class', 'transform', 'data-actual-fence-content', 'data-source'] });
        observed.set(surface, observer);
      }
      const shadow = host.shadowRoot;
      if (!shadow) continue;
      if (!shadow.querySelector('[data-ccgui-selection-style]')) {
        const style = document.createElement('style');
        style.dataset.ccguiSelectionStyle = '';
        style.textContent = 'svg text,svg tspan,svg foreignObject,svg foreignObject * { user-select: text !important; -webkit-user-select: text !important; cursor: text; }';
        shadow.append(style);
      }
    }
    for (const [surface, observer] of observed) {
      if (!(surface instanceof ShadowRoot ? surface.host : surface).isConnected) {
        observer.disconnect(); observed.delete(surface);
      }
    }
  };
}
