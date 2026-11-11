import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_READY_EVENT } from '../utils/bridgeStartup';
import { useOmpPlanUsage } from './useOmpPlanUsage';

const w = window as unknown as {
  sendToJava?: (cmd: string) => void;
  updateOmpPlanUsage?: (json: string) => void;
};

const unavailablePayload = {
  present: false,
  unavailable: true,
  provider: 'omp',
  message: 'OMP usage unavailable',
};

const presentPayload = {
  ok: true,
  present: true,
  provider: 'omp',
  source: 'omp usage',
  capacity_pct: 10,
  period_type: '5h',
  windows: [
    { id: '5h', used_pct: 10, reset_at: '2026-11-10T20:00:00.000Z', period_type: '5h' },
    { id: '7d', used_pct: 13, reset_at: '2026-11-13T20:00:00.000Z', period_type: '7d' },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete w.sendToJava;
  delete w.updateOmpPlanUsage;
});

describe('useOmpPlanUsage', () => {
  it('shows the 5h and 7d windows from a present payload', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useOmpPlanUsage('omp'));
    expect(w.sendToJava).toHaveBeenCalledWith('get_omp_plan_usage:');

    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.capacityPct).toBe(10);
    expect(result.current.snapshot?.windows?.map((win) => win.id)).toEqual(['5h', '7d']);
  });

  it('stays hidden while usage is unavailable', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useOmpPlanUsage('omp'));

    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('hides the chip when a present payload is followed by unavailable', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useOmpPlanUsage('omp'));

    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');

    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('is empty for other providers and never polls', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useOmpPlanUsage('claude'));
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
    expect(w.sendToJava).not.toHaveBeenCalled();
  });

  it('polls every 60s after a present payload', () => {
    vi.useFakeTimers();
    w.sendToJava = vi.fn();
    renderHook(() => useOmpPlanUsage('omp'));

    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(presentPayload));
    });
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);
  });

  it('follows the failure ladder 20s -> 1m -> 5m -> 30m and resets on success', () => {
    vi.useFakeTimers();
    w.sendToJava = vi.fn();
    renderHook(() => useOmpPlanUsage('omp'));
    const failAndAdvance = (delayMs: number, expectedCalls: number) => {
      act(() => {
        w.updateOmpPlanUsage?.(JSON.stringify(unavailablePayload));
      });
      act(() => {
        vi.advanceTimersByTime(delayMs - 1);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(expectedCalls - 1);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(expectedCalls);
    };

    failAndAdvance(20_000, 2);
    failAndAdvance(60_000, 3);
    failAndAdvance(300_000, 4);
    failAndAdvance(1_800_000, 5);
    failAndAdvance(1_800_000, 6);

    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(presentPayload));
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(7);

    failAndAdvance(20_000, 8);
  });

  it('polls again when a reply never arrives', () => {
    vi.useFakeTimers();
    w.sendToJava = vi.fn();
    renderHook(() => useOmpPlanUsage('omp'));

    act(() => {
      vi.advanceTimersByTime(119_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);
  });

  it('stops polling and drops the reading when the provider changes away from omp', () => {
    vi.useFakeTimers();
    w.sendToJava = vi.fn();
    const { result, rerender } = renderHook(
      ({ provider }) => useOmpPlanUsage(provider),
      { initialProps: { provider: 'omp' } },
    );
    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');

    rerender({ provider: 'claude' });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();

    act(() => {
      vi.advanceTimersByTime(3_600_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
  });

  it('ignores a reply that belongs to a superseded poll', () => {
    w.sendToJava = vi.fn();
    const { result, rerender } = renderHook(
      ({ provider }) => useOmpPlanUsage(provider),
      { initialProps: { provider: 'omp' } },
    );
    const staleReply = w.updateOmpPlanUsage;

    rerender({ provider: 'claude' });
    act(() => {
      staleReply?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('idle');
  });

  it('polls on BRIDGE_READY_EVENT when sendToJava was not installed at mount', () => {
    delete w.sendToJava;
    const { unmount } = renderHook(() => useOmpPlanUsage('omp'));

    w.sendToJava = vi.fn();
    act(() => {
      window.dispatchEvent(new Event(BRIDGE_READY_EVENT));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
    expect(w.sendToJava).toHaveBeenCalledWith('get_omp_plan_usage:');

    unmount();
    act(() => {
      window.dispatchEvent(new Event(BRIDGE_READY_EVENT));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous present reading on a JSON parse error and backs off at 20s', () => {
    vi.useFakeTimers();
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useOmpPlanUsage('omp'));

    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(presentPayload));
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);

    act(() => {
      w.updateOmpPlanUsage?.('not json');
    });
    expect(result.current.status).toBe('ready');
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(3);
  });
});
