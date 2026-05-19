import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDialogCountdownTimeout } from './useDialogCountdownTimeout.js';

describe('useDialogCountdownTimeout', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('fires onTimeout once when the countdown elapses', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const { result } = renderHook(() => useDialogCountdownTimeout({
      isOpen: true,
      requestKey: 'request-1',
      timeoutSeconds: 3,
      onTimeout,
    }));

    expect(result.current.remainingSeconds).toBe(3);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(result.current.remainingSeconds).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('manual submission suppresses the timeout callback', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const { result } = renderHook(() => useDialogCountdownTimeout({
      isOpen: true,
      requestKey: 'request-1',
      timeoutSeconds: 3,
      onTimeout,
    }));

    act(() => {
      expect(result.current.markSubmitted()).toBe(true);
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current.markSubmitted()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rejects manual submission immediately after the timer expires', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const { result } = renderHook(() => useDialogCountdownTimeout({
      isOpen: true,
      requestKey: 'request-1',
      timeoutSeconds: 3,
      onTimeout,
    }));

    act(() => {
      vi.advanceTimersByTime(3_000);
      expect(result.current.markSubmitted()).toBe(false);
    });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('rejects manual submission by deadline even before a delayed timer callback runs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onTimeout = vi.fn();

    const { result } = renderHook(() => useDialogCountdownTimeout({
      isOpen: true,
      requestKey: 'request-1',
      timeoutSeconds: 3,
      onTimeout,
    }));

    act(() => {
      vi.setSystemTime(3_001);
      expect(result.current.markSubmitted()).toBe(false);
    });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('fires timeout on the next tick when wall-clock deadline already passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onTimeout = vi.fn();

    const { result } = renderHook(() => useDialogCountdownTimeout({
      isOpen: true,
      requestKey: 'request-1',
      timeoutSeconds: 3,
      onTimeout,
    }));

    act(() => {
      vi.setSystemTime(10_000);
      vi.advanceTimersByTime(1_000);
    });

    expect(result.current.remainingSeconds).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('updates the active countdown when timeoutSeconds changes before submission', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const { rerender, result } = renderHook(
      ({ timeoutSeconds }) => useDialogCountdownTimeout({
        isOpen: true,
        requestKey: 'request-1',
        timeoutSeconds,
        onTimeout,
      }),
      { initialProps: { timeoutSeconds: 3 } },
    );

    rerender({ timeoutSeconds: 5 });
    expect(result.current.remainingSeconds).toBe(5);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(onTimeout).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
