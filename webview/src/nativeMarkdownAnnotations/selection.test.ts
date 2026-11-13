import { capturePreviewSelection, findSourceElement, positionAttribute, sourceRange } from './selection';

describe('native Markdown selection mapping', () => {
  let root: HTMLDivElement;
  beforeEach(() => {
    document.head.innerHTML = '<meta name="markdown-position-attribute-name" content="data-sourcepos">';
    root = document.createElement('div');
    root.innerHTML = '<p data-sourcepos="0..12">first <strong>bold</strong></p><p data-sourcepos="14..30">第二段😀</p>';
    document.body.replaceChildren(root);
    window.getSelection()?.removeAllRanges();
  });

  function select(start: Node, from: number, end: Node, to: number) {
    const range = document.createRange();
    range.setStart(start, from); range.setEnd(end, to);
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 10, bottom: 20 }) });
    window.getSelection()?.addRange(range);
  }

  it('uses native block offsets for formatted text, preserving the displayed quote', () => {
    select(root.querySelector('strong')!.firstChild!, 0, root.querySelector('strong')!.firstChild!, 4);
    expect(capturePreviewSelection(root)).toEqual({ start: 0, end: 12, selectedText: 'bold', positionAttribute: 'data-sourcepos', left: 10, top: 20 });
    expect(findSourceElement(root, 0, 12)).toBe(root.firstElementChild);
  });

  it('captures selections across native blocks without confusing UTF-16 with source offsets', () => {
    select(root.firstElementChild!.firstChild!, 0, root.lastElementChild!.firstChild!, 5);
    expect(capturePreviewSelection(root)).toMatchObject({ start: 0, end: 30 });
  });

  it('rejects selections outside the native root and invalid source metadata', () => {
    const outside = document.createElement('p'); outside.textContent = 'outside'; document.body.append(outside);
    select(root.firstElementChild!.firstChild!, 0, outside.firstChild!, 7);
    expect(capturePreviewSelection(root)).toBeNull();
    expect(sourceRange(root, 'data-sourcepos')).toBeNull();
    document.querySelector('meta')!.setAttribute('content', 'x]body');
    expect(positionAttribute()).toBeNull();
  });
});
