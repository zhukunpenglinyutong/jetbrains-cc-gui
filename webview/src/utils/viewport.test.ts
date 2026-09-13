import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLogicalOffsetTop } from './viewport';

describe('getLogicalOffsetTop', () => {
  let appEl: HTMLElement;
  let originalInnerHeight: number;

  beforeEach(() => {
    appEl = document.createElement('div');
    originalInnerHeight = window.innerHeight;
    vi.spyOn(document, 'getElementById').mockImplementation(
      (id: string) => (id === 'app' ? appEl : null) as HTMLElement | null,
    );
    vi.spyOn(appEl, 'getBoundingClientRect');
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: originalInnerHeight,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const setAppRect = (height: number) => {
    vi.mocked(appEl.getBoundingClientRect).mockReturnValue({
      height,
      width: 800,
      top: 0,
      left: 0,
      right: 800,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  };

  const setZoom = (zoom: string) => {
    vi.stubGlobal(
      'getComputedStyle',
      () => ({ zoom }) as unknown as CSSStyleDeclaration,
    );
  };

  const makeEl = (top: number) => {
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top,
      height: 0,
      width: 0,
      left: 0,
      right: 0,
      bottom: top,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    return el;
  };

  it('returns the raw delta when zoom is 1 (no #app zoom)', () => {
    setZoom('1');
    setAppRect(1000);
    const node = makeEl(200);
    const container = makeEl(50);
    // 200 - 50 = 150, no compensation
    expect(getLogicalOffsetTop(node, container)).toBe(150);
  });

  it('divides the delta by zoom on newer JCEF (appRect.height == innerHeight)', () => {
    // The user's case: 90% zoom, newer variant where gBCR returns zoomed values.
    setZoom('0.9');
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 1000,
    });
    setAppRect(1000); // == innerHeight -> newer variant
    const node = makeEl(200);
    const container = makeEl(50);
    // raw delta 150 is zoom-scaled; /0.9 = 166.66... (the true layout delta)
    expect(getLogicalOffsetTop(node, container)).toBeCloseTo(166.667, 2);
  });

  it('returns the raw delta on older JCEF (appRect.height != innerHeight)', () => {
    // Older builds return unzoomed layout values: appRect.height = innerHeight / zoom.
    setZoom('0.9');
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 1000,
    });
    setAppRect(1111); // 1000 / 0.9 ~ 1111, != innerHeight -> older variant
    const node = makeEl(200);
    const container = makeEl(50);
    expect(getLogicalOffsetTop(node, container)).toBe(150);
  });
});
