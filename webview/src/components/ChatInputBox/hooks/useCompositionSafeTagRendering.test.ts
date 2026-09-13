import { act, renderHook } from '@testing-library/react';
import { useCompositionSafeTagRendering } from './useCompositionSafeTagRendering.js';

describe('useCompositionSafeTagRendering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders after the delay when no composition is active', () => {
    const renderTags = vi.fn();
    const isComposingRef = { current: false };
    const { result } = renderHook(() =>
      useCompositionSafeTagRendering({ isComposingRef, renderTags, delay: 300 })
    );

    act(() => {
      result.current.scheduleTagRendering();
      vi.advanceTimersByTime(300);
    });

    expect(renderTags).toHaveBeenCalledTimes(1);
  });

  it('does not schedule rendering while composition is active', () => {
    const renderTags = vi.fn();
    const isComposingRef = { current: true };
    const { result } = renderHook(() =>
      useCompositionSafeTagRendering({ isComposingRef, renderTags, delay: 300 })
    );

    act(() => {
      result.current.scheduleTagRendering();
      vi.advanceTimersByTime(300);
    });

    expect(renderTags).not.toHaveBeenCalled();
  });

  it('drops pending rendering when composition starts before the callback runs', () => {
    const renderTags = vi.fn();
    const isComposingRef = { current: false };
    const { result } = renderHook(() =>
      useCompositionSafeTagRendering({ isComposingRef, renderTags, delay: 300 })
    );

    act(() => {
      result.current.scheduleTagRendering();
      isComposingRef.current = true;
      vi.advanceTimersByTime(300);
    });

    expect(renderTags).not.toHaveBeenCalled();
  });

  it('cancels pending rendering explicitly and on unmount', () => {
    const renderTags = vi.fn();
    const isComposingRef = { current: false };
    const { result, unmount } = renderHook(() =>
      useCompositionSafeTagRendering({ isComposingRef, renderTags, delay: 300 })
    );

    act(() => {
      result.current.scheduleTagRendering();
      result.current.cancelTagRendering();
      vi.advanceTimersByTime(300);
      result.current.scheduleTagRendering();
    });
    unmount();
    act(() => vi.advanceTimersByTime(300));

    expect(renderTags).not.toHaveBeenCalled();
  });

  it('renders immediately only when safe and cancels pending debounced work', () => {
    const renderTags = vi.fn();
    const isComposingRef = { current: false };
    const { result } = renderHook(() =>
      useCompositionSafeTagRendering({ isComposingRef, renderTags, delay: 300 })
    );

    act(() => {
      result.current.scheduleTagRendering();
      result.current.renderTagsNowIfSafe();
      vi.advanceTimersByTime(300);
    });
    expect(renderTags).toHaveBeenCalledTimes(1);

    isComposingRef.current = true;
    act(() => result.current.renderTagsNowIfSafe());
    expect(renderTags).toHaveBeenCalledTimes(1);
  });
});
