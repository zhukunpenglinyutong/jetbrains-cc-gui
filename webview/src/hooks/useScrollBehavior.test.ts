import { act, renderHook } from '@testing-library/react';
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

let resizeObserverCallback: ResizeObserverCallback | null = null;

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }

  observe() {}

  disconnect() {}
}

function createScrollableContainer() {
  const container = document.createElement('div');
  let scrollHeightValue = 1000;
  const clientHeightValue = 400;
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
  };
}

describe('useScrollBehavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    resizeObserverCallback = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

    act(() => {
      vi.runAllTimers();
    });

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

    act(() => {
      vi.runAllTimers();
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
    });

    expect(container.classList.contains('scroll-anchor-enabled')).toBe(true);

    act(() => {
      setScrollTop(600);
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: 20 }));
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

    act(() => {
      vi.runAllTimers();
    });

    expect(getScrollTop()).toBe(600);

    act(() => {
      setScrollTop(600);
      shouldGrowOnMeasure = true;
      resizeObserverCallback?.([], {} as ResizeObserver);
    });

    expect(getScrollTop()).toBe(1000);
    expect(container.classList.contains('scroll-anchor-enabled')).toBe(false);
    expect(endRectSpy).toHaveBeenCalled();
  });
});