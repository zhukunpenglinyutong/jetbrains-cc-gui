import { act, cleanup, renderHook } from '@testing-library/react';
import { useScrollBehavior } from './useScrollBehavior';
import type { ClaudeMessage } from '../types';

interface HookProps {
  currentView: 'chat' | 'history' | 'settings';
  messages: ClaudeMessage[];
  loading: boolean;
  streamingActive: boolean;
}

const INITIAL_PROPS: HookProps = {
  currentView: 'history',
  messages: [] as ClaudeMessage[],
  loading: false,
  streamingActive: false,
};

let resizeObservers: ResizeObserverMock[] = [];
let frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

class ResizeObserverMock {
  readonly observedElements = new Set<Element>();
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  observe = vi.fn((element: Element) => {
    this.observedElements.add(element);
  });

  disconnect = vi.fn(() => {
    this.observedElements.clear();
  });
}

function notifyResize(element: Element) {
  for (const observer of resizeObservers) {
    if (observer.observedElements.has(element)) {
      observer.callback([{ target: element } as ResizeObserverEntry], observer as unknown as ResizeObserver);
    }
  }
}

function advanceAnimationFrame() {
  // Callbacks scheduled during a frame belong to the next frame.
  for (const id of [...frameCallbacks.keys()]) {
    const callback = frameCallbacks.get(id);
    frameCallbacks.delete(id);
    callback?.(0);
  }
}

function finishPendingScroll() {
  act(() => {
    vi.runAllTimers();
    advanceAnimationFrame();
    advanceAnimationFrame();
  });
}

function createScrollableContainer() {
  const container = document.createElement('div');
  let scrollHeightValue = 1000;
  let clientHeightValue = 400;
  let scrollTopValue = 600;

  Object.defineProperty(container, 'clientHeight', {
    configurable: true,
    get: () => clientHeightValue,
  });

  Object.defineProperty(container, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeightValue,
  });

  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => scrollTopValue,
    set: (value: number) => {
      const maxScrollTop = Math.max(0, scrollHeightValue - clientHeightValue);
      scrollTopValue = Math.min(Math.max(0, value), maxScrollTop);
    },
  });

  return {
    container,
    getScrollTop: () => scrollTopValue,
    setScrollTop: (value: number) => {
      const maxScrollTop = Math.max(0, scrollHeightValue - clientHeightValue);
      scrollTopValue = Math.min(Math.max(0, value), maxScrollTop);
    },
    setScrollHeight: (value: number) => {
      scrollHeightValue = value;
    },
    setClientHeight: (value: number) => {
      clientHeightValue = value;
    },
  };
}

function renderChat(container: HTMLDivElement, end: HTMLDivElement | null = null) {
  const hook = renderHook((props: HookProps) => useScrollBehavior(props), {
    initialProps: INITIAL_PROPS,
  });
  const chatProps: HookProps = { ...INITIAL_PROPS, currentView: 'chat' };

  act(() => {
    hook.result.current.messagesContainerRef.current = container;
    hook.result.current.messagesEndRef.current = end;
  });
  hook.rerender(chatProps);
  finishPendingScroll();

  return { ...hook, chatProps };
}

describe('useScrollBehavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    frameCallbacks = new Map();
    nextFrameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frameCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frameCallbacks.delete(id);
    });
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    resizeObservers = [];
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('enables browser scroll anchoring after the user pauses auto-scroll with wheel up', () => {
    const { container } = createScrollableContainer();
    const { result, rerender } = renderHook((props: HookProps) => useScrollBehavior(props), {
      initialProps: INITIAL_PROPS,
    });

    act(() => {
      result.current.messagesContainerRef.current = container;
    });

    rerender({ ...INITIAL_PROPS, currentView: 'chat' });

    finishPendingScroll();

    act(() => {
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
    });

    expect(result.current.userPausedRef.current).toBe(true);
    expect(result.current.isUserAtBottomRef.current).toBe(false);
    expect(container.classList.contains('scroll-anchor-enabled')).toBe(true);
  });

  it('disables browser scroll anchoring once the user returns to the bottom', () => {
    const { container, setScrollTop, getScrollTop } = createScrollableContainer();
    const { result, rerender } = renderHook((props: HookProps) => useScrollBehavior(props), {
      initialProps: INITIAL_PROPS,
    });

    act(() => {
      result.current.messagesContainerRef.current = container;
    });

    rerender({ ...INITIAL_PROPS, currentView: 'chat' });

    finishPendingScroll();
    act(() => {
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
    });

    expect(container.classList.contains('scroll-anchor-enabled')).toBe(true);

    act(() => {
      setScrollTop(600);
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: 20 }));
      advanceAnimationFrame();
    });

    expect(result.current.userPausedRef.current).toBe(false);
    expect(result.current.isUserAtBottomRef.current).toBe(true);
    expect(container.classList.contains('scroll-anchor-enabled')).toBe(false);
    expect(getScrollTop()).toBe(600);
  });

  it('keeps following the bottom when content grows inside the last message without changing messages', () => {
    const { container, getScrollTop, setScrollTop, setScrollHeight } = createScrollableContainer();
    const root = document.createElement('div');
    const end = document.createElement('div');
    root.appendChild(end);
    container.appendChild(root);
    let shouldGrowOnMeasure = false;
    const endRectSpy = vi.spyOn(end, 'getBoundingClientRect').mockImplementation(() => {
      if (shouldGrowOnMeasure) {
        setScrollHeight(1400);
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    const { result, rerender } = renderHook((props: HookProps) => useScrollBehavior(props), {
      initialProps: INITIAL_PROPS,
    });

    act(() => {
      result.current.messagesContainerRef.current = container;
      result.current.messagesEndRef.current = end;
    });

    rerender({ ...INITIAL_PROPS, currentView: 'chat', messages: [{ type: 'assistant', content: 'task', timestamp: '2026-04-27T00:00:00.000Z' }] });

    finishPendingScroll();

    expect(getScrollTop()).toBe(600);

    act(() => {
      setScrollTop(600);
      shouldGrowOnMeasure = true;
      notifyResize(root);
      advanceAnimationFrame();
    });

    expect(getScrollTop()).toBe(1000);
    expect(container.classList.contains('scroll-anchor-enabled')).toBe(false);
    expect(endRectSpy).toHaveBeenCalled();
  });

  it('re-anchors to the bottom when the container is squeezed past the bottom threshold', () => {
    const { container, getScrollTop, setClientHeight } = createScrollableContainer();
    const { result, rerender } = renderHook((props: HookProps) => useScrollBehavior(props), {
      initialProps: INITIAL_PROPS,
    });

    act(() => {
      result.current.messagesContainerRef.current = container;
    });

    rerender({ ...INITIAL_PROPS, currentView: 'chat' });

    finishPendingScroll();

    // A layout-only squeeze must preserve follow intent beyond the 100px threshold.
    act(() => {
      setClientHeight(250);
      notifyResize(container);
      advanceAnimationFrame();
    });

    expect(getScrollTop()).toBe(750);
    expect(result.current.isUserAtBottomRef.current).toBe(true);
    expect(container.classList.contains('scroll-anchor-enabled')).toBe(false);
  });

  it('keeps the paused position when the container is squeezed', () => {
    const { container, getScrollTop, setClientHeight } = createScrollableContainer();
    const { result, rerender } = renderHook((props: HookProps) => useScrollBehavior(props), {
      initialProps: INITIAL_PROPS,
    });

    act(() => {
      result.current.messagesContainerRef.current = container;
    });

    rerender({ ...INITIAL_PROPS, currentView: 'chat' });

    finishPendingScroll();
    act(() => {
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
      setClientHeight(250);
      notifyResize(container);
      advanceAnimationFrame();
    });

    expect(result.current.userPausedRef.current).toBe(true);
    expect(getScrollTop()).toBe(600);
    expect(container.classList.contains('scroll-anchor-enabled')).toBe(true);
  });

  it('keeps the scrolled-up position and refreshes the bottom state when the container is squeezed', () => {
    const { container, getScrollTop, setScrollTop, setClientHeight } = createScrollableContainer();
    const { result, rerender } = renderHook((props: HookProps) => useScrollBehavior(props), {
      initialProps: INITIAL_PROPS,
    });

    act(() => {
      result.current.messagesContainerRef.current = container;
    });

    rerender({ ...INITIAL_PROPS, currentView: 'chat' });

    finishPendingScroll();
    act(() => {
      setScrollTop(100);
      container.dispatchEvent(new Event('scroll'));
      advanceAnimationFrame();
    });

    expect(result.current.isUserAtBottomRef.current).toBe(false);
    expect(result.current.userPausedRef.current).toBe(false);

    act(() => {
      setClientHeight(250);
      notifyResize(container);
      advanceAnimationFrame();
    });

    expect(getScrollTop()).toBe(100);
    expect(result.current.isUserAtBottomRef.current).toBe(false);
  });

  it('lets a user scroll away before a queued resize follows the bottom', () => {
    const { container, getScrollTop, setScrollTop, setClientHeight } = createScrollableContainer();
    const { result } = renderChat(container);

    act(() => {
      setClientHeight(250);
      notifyResize(container);
      setScrollTop(100);
      container.dispatchEvent(new Event('scroll'));
      advanceAnimationFrame();
    });

    expect(getScrollTop()).toBe(100);
    expect(result.current.isUserAtBottomRef.current).toBe(false);
    expect(container.classList.contains('scroll-anchor-enabled')).toBe(true);
  });

  it('keeps following a resize after an automatic scroll emits a scroll event', () => {
    const { container, getScrollTop, setClientHeight } = createScrollableContainer();
    const { result, rerender, chatProps } = renderChat(container);

    rerender({ ...chatProps, loading: true });
    expect(result.current.isAutoScrollingRef.current).toBe(true);
    act(() => {
      container.dispatchEvent(new Event('scroll'));
      setClientHeight(250);
      notifyResize(container);
      advanceAnimationFrame();
    });

    expect(getScrollTop()).toBe(750);
    expect(result.current.isUserAtBottomRef.current).toBe(true);
  });

  it('honors wheel-up intent after a wheel-down check was queued', () => {
    const { container } = createScrollableContainer();
    const { result } = renderChat(container);

    act(() => {
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: 20 }));
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
      advanceAnimationFrame();
    });

    expect(result.current.userPausedRef.current).toBe(true);
    expect(result.current.isUserAtBottomRef.current).toBe(false);
    expect(container.classList.contains('scroll-anchor-enabled')).toBe(true);
  });

  it('shares one scroll per frame between streaming updates and both resize targets', () => {
    const { container, getScrollTop, setClientHeight } = createScrollableContainer();
    const root = document.createElement('div');
    const end = document.createElement('div');
    const scrollIntoView = vi.fn();
    end.scrollIntoView = scrollIntoView;
    root.appendChild(end);
    container.appendChild(root);
    const { rerender, chatProps } = renderChat(container, end);
    scrollIntoView.mockClear();

    rerender({ ...chatProps, streamingActive: true });
    act(() => {
      setClientHeight(250);
      notifyResize(container);
      notifyResize(root);
      advanceAnimationFrame();
    });

    expect(getScrollTop()).toBe(750);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(resizeObservers).toHaveLength(1);
    expect(resizeObservers[0].observe).toHaveBeenCalledTimes(2);
    expect(resizeObservers[0].disconnect).not.toHaveBeenCalled();
  });

  it('cancels a queued streaming scroll when leaving the chat view', () => {
    const { container, getScrollTop, setScrollTop } = createScrollableContainer();
    const { rerender, chatProps } = renderChat(container);

    rerender({ ...chatProps, streamingActive: true });
    act(() => {
      setScrollTop(100);
    });
    rerender({ ...chatProps, currentView: 'history', streamingActive: true });
    act(() => {
      advanceAnimationFrame();
    });

    expect(getScrollTop()).toBe(100);
    expect(resizeObservers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('honors a pause made between a resize notification and the next frame', () => {
    const { container, getScrollTop, setClientHeight } = createScrollableContainer();
    const { result } = renderChat(container);

    act(() => {
      setClientHeight(250);
      notifyResize(container);
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
      advanceAnimationFrame();
    });

    expect(getScrollTop()).toBe(600);
    expect(result.current.userPausedRef.current).toBe(true);
    expect(container.classList.contains('scroll-anchor-enabled')).toBe(true);
  });

  it('disconnects resize targets and cancels their queued scroll on unmount', () => {
    const { container, getScrollTop, setClientHeight } = createScrollableContainer();
    const { unmount } = renderChat(container);

    act(() => {
      setClientHeight(250);
      notifyResize(container);
    });
    unmount();
    act(() => {
      advanceAnimationFrame();
      notifyResize(container);
      advanceAnimationFrame();
    });

    expect(getScrollTop()).toBe(600);
    expect(resizeObservers[0].disconnect).toHaveBeenCalledOnce();
  });
});
