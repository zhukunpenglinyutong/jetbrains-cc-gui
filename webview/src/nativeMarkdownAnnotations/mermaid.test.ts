import { createMermaidAdapter, diagramSource } from './mermaid';

describe('native and Visualizer Mermaid adapters', () => {
  it('decodes the official UTF-8 Base64 fence, including Chinese and emoji', () => {
    const host = document.createElement('div');
    const source = 'graph TD\r\nA[任务😀] --> B[完成]';
    host.setAttribute('data-actual-fence-content', btoa(String.fromCharCode(...new TextEncoder().encode(source))));
    expect(diagramSource(host)).toBe('graph TD\nA[任务😀] --> B[完成]');
    host.setAttribute('data-actual-fence-content', 'not base64!');
    expect(diagramSource(host)).toBeNull();
  });

  it('maps repeated diagrams across both renderers and invalidates changed source', () => {
    const root = document.createElement('div'); document.body.replaceChildren(root);
    const source = 'graph TD; A-->B';
    const native = document.createElement('div'); native.className = 'mermaid';
    native.setAttribute('data-actual-fence-content', btoa(source));
    const visualizer = document.createElement('div'); visualizer.className = 'mermaid-diagram';
    visualizer.dataset.source = source;
    root.append(native, visualizer);
    const adapt = createMermaidAdapter(() => {}, () => true);
    const diagrams = [{ start: 10, end: 50, source }, { start: 60, end: 100, source }];
    adapt(root, 'data-src', diagrams);
    expect(native.getAttribute('data-src')).toBe('10..50');
    expect(visualizer.getAttribute('data-src')).toBe('60..100');
    native.setAttribute('data-actual-fence-content', btoa('graph TD; X-->Y'));
    adapt(root, 'data-src', diagrams);
    expect(native.hasAttribute('data-src')).toBe(false);
  });
});
