import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDialogCountdownTimeout } from './useDialogCountdownTimeout.js';

describe('useDialogCountdownTimeout', () => {
  it('retries a refused submission within the original deadline', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { result } = renderHook(() => useDialogCountdownTimeout({ isOpen: true,
      requestKey: 'retry', timeoutSeconds: 3, onTimeout }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.markSubmitted()).toBe(true);
    result.current.restoreSubmission();
    expect(result.current.markSubmitted()).toBe(true);
    result.current.restoreSubmission();
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.remainingSeconds).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    result.current.restoreSubmission();
    expect(result.current.markSubmitted()).toBe(false);
  });
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

  it('ignores timeoutSeconds prop changes while the same dialog is open', () => {
    // The Java-side safety net is scheduled once when the dialog is created
    // and cannot be rescheduled. If the frontend were to update its countdown
    // when the user changes the setting, the two timers would drift apart and
    // the backend could auto-reject while the user still sees a running dialog.
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

    // Simulate the user changing the setting while the dialog is visible.
    rerender({ timeoutSeconds: 5 });
    // The countdown must stay at the original value (3), not jump to 5.
    expect(result.current.remainingSeconds).toBe(3);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('keeps the backend deadline after the dialog remounts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onTimeout = vi.fn();

    const { rerender, result } = renderHook(
      ({ isOpen }: { isOpen: boolean }) => useDialogCountdownTimeout({
        isOpen,
        requestKey: 'request-1',
        timeoutSeconds: 30,
        deadlineMs: 3_000,
        onTimeout,
      }),
      { initialProps: { isOpen: true } },
    );

    act(() => {
      vi.setSystemTime(1_000);
    });
    rerender({ isOpen: false });
    rerender({ isOpen: true });

    expect(result.current.remainingSeconds).toBe(2);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('restarts the countdown when the open request is replaced by a later deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onTimeout = vi.fn();

    const { rerender, result } = renderHook(
      ({ deadlineMs }: { deadlineMs: number }) => useDialogCountdownTimeout({
        isOpen: true,
        requestKey: 'channel-1',
        timeoutSeconds: 30,
        deadlineMs,
        onTimeout,
      }),
      { initialProps: { deadlineMs: 5_000 } },
    );
    expect(result.current.remainingSeconds).toBe(5);

    // The session reuses one channelId, and a force-close plus the next show for
    // that id are injected in the same JS batch: isOpen and requestKey stay put
    // while the payload — and its deadline — is replaced.
    act(() => {
      vi.setSystemTime(1_000);
    });
    rerender({ deadlineMs: 9_000 });

    expect(result.current.remainingSeconds).toBe(8);
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('restarts an expired timer when the same id receives a new deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onTimeout = vi.fn();
    const { rerender } = renderHook(
      ({ deadlineMs }) => useDialogCountdownTimeout({
        isOpen: true,
        requestKey: 'channel-1',
        timeoutSeconds: 30,
        deadlineMs,
        onTimeout,
      }),
      { initialProps: { deadlineMs: 1_000 } },
    );
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    rerender({ deadlineMs: 3_000 });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(onTimeout).toHaveBeenCalledTimes(2);
  });

  it('uses the new timeoutSeconds when a fresh dialog opens (requestKey changes)', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const { rerender, result } = renderHook(
      ({ requestKey, timeoutSeconds }: { requestKey: string | null; timeoutSeconds: number }) => useDialogCountdownTimeout({
        isOpen: true,
        requestKey,
        timeoutSeconds,
        onTimeout,
      }),
      { initialProps: { requestKey: 'request-1' as string | null, timeoutSeconds: 3 } },
    );

    // Close the first dialog and open a second one with a different timeout.
    rerender({ requestKey: null, timeoutSeconds: 5 });
    rerender({ requestKey: 'request-2', timeoutSeconds: 5 });
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
