import { scrollCaretIntoView } from './scrollCaretIntoView.js';

function createSelection(editable: HTMLElement, focusOffset = 0): void {
  const textNode = document.createTextNode('draft');
  editable.append(textNode);
  const range = document.createRange();
  range.setStart(textNode, focusOffset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function mockRect(element: Element, rect: Partial<DOMRect>): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    bottom: 100,
    left: 0,
    right: 100,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect);
}

function mockCaretRect(rect: Partial<DOMRect>): void {
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
    {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect,
    } as DOMRect,
  ] as unknown as DOMRectList);
}

describe('scrollCaretIntoView', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('scrolls only the amount needed to reveal a caret below the wrapper', () => {
    const wrapper = document.createElement('div');
    const editable = document.createElement('div');
    wrapper.append(editable);
    document.body.append(wrapper);
    Object.defineProperty(wrapper, 'clientHeight', { configurable: true, value: 100 });
    mockRect(wrapper, { top: 0, bottom: 100 });
    createSelection(editable);

    mockCaretRect({ top: 130, bottom: 150 });

    scrollCaretIntoView(editable);

    expect(wrapper.scrollTop).toBe(50);
  });

  it('scrolls upward when the caret is above the wrapper', () => {
    const wrapper = document.createElement('div');
    const editable = document.createElement('div');
    wrapper.append(editable);
    document.body.append(wrapper);
    Object.defineProperty(wrapper, 'clientHeight', { configurable: true, value: 100 });
    wrapper.scrollTop = 80;
    mockRect(wrapper, { top: 0, bottom: 100 });
    createSelection(editable);

    mockCaretRect({ top: -20, bottom: 0 });

    scrollCaretIntoView(editable);

    expect(wrapper.scrollTop).toBe(60);
  });

  it('leaves the wrapper unchanged when the caret is already visible', () => {
    const wrapper = document.createElement('div');
    const editable = document.createElement('div');
    wrapper.append(editable);
    document.body.append(wrapper);
    Object.defineProperty(wrapper, 'clientHeight', { configurable: true, value: 100 });
    wrapper.scrollTop = 25;
    mockRect(wrapper, { top: 0, bottom: 100 });
    createSelection(editable);

    mockCaretRect({ top: 40, bottom: 60 });

    scrollCaretIntoView(editable);

    expect(wrapper.scrollTop).toBe(25);
  });

  it('reveals a blank line when Chromium gives the collapsed caret no rectangle', () => {
    const wrapper = document.createElement('div');
    const editable = document.createElement('div');
    const line = document.createElement('div');
    line.append(document.createElement('br'));
    editable.append(line);
    wrapper.append(editable);
    document.body.append(wrapper);
    Object.defineProperty(wrapper, 'clientHeight', { configurable: true, value: 100 });
    wrapper.scrollTop = 300;
    mockRect(wrapper, { top: 200, bottom: 300 });
    const range = document.createRange();
    range.setStart(line, 0);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      return (this.collapsed ? [] : [{ top: 500, bottom: 520, height: 20 }]) as unknown as DOMRectList;
    });
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 0, height: 0,
    } as DOMRect);

    scrollCaretIntoView(editable);

    expect(wrapper.scrollTop).toBe(520);
  });

  it.each([0.8, 0.9, 1, 1.4])('keeps bottom padding clear at %s app zoom', (zoom) => {
    const app = document.createElement('div');
    app.id = 'app';
    app.style.zoom = String(zoom);
    const wrapper = document.createElement('div');
    wrapper.style.padding = '6px';
    const editable = document.createElement('div');
    wrapper.append(editable);
    app.append(wrapper);
    document.body.append(app);
    mockRect(app, { height: window.innerHeight });
    Object.defineProperty(wrapper, 'clientHeight', { configurable: true, value: 100 });
    mockRect(wrapper, { top: 200, bottom: 200 + 100 * zoom, height: 100 * zoom });
    createSelection(editable);
    mockCaretRect({ top: 200 + 82 * zoom, bottom: 200 + 102 * zoom });

    scrollCaretIntoView(editable);

    expect(wrapper.scrollTop).toBeCloseTo(8);
  });

  it('converts upward scrolling to logical pixels at reduced app zoom', () => {
    const app = document.createElement('div');
    app.id = 'app';
    app.style.zoom = '0.8';
    const wrapper = document.createElement('div');
    wrapper.style.padding = '6px';
    const editable = document.createElement('div');
    wrapper.append(editable);
    app.append(wrapper);
    document.body.append(app);
    mockRect(app, { height: window.innerHeight });
    Object.defineProperty(wrapper, 'clientHeight', { configurable: true, value: 100 });
    wrapper.scrollTop = 50;
    mockRect(wrapper, { top: 200, bottom: 280, height: 80 });
    createSelection(editable);
    mockCaretRect({ top: 200 - 2 * 0.8, bottom: 200 + 18 * 0.8 });

    scrollCaretIntoView(editable);

    expect(wrapper.scrollTop).toBeCloseTo(42);
  });
});
