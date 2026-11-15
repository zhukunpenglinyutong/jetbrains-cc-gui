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
    const { result } = renderHook(() => useOmpPlanUsage('omp', 'auto'));
    expect(w.sendToJava).toHaveBeenCalledWith('get_omp_plan_usage:auto');

    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.capacityPct).toBe(10);
    expect(result.current.snapshot?.windows?.map((win) => win.id)).toEqual(['5h', '7d']);
  });

  it('stays hidden while usage is unavailable', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useOmpPlanUsage('omp', 'auto'));

    act(() => {
      w.updateOmpPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('hides the chip when a present payload is followed by unavailable', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useOmpPlanUsage('omp', 'auto'));

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
    const { result } = renderHook(() => useOmpPlanUsage('claude', 'auto'));
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
    expect(w.sendToJava).not.toHaveBeenCalled();
  });

  it('polls every 60s after a present payload', () => {
    vi.useFakeTimers();
    w.sendToJava = vi.fn();
    renderHook(() => useOmpPlanUsage('omp', 'auto'));

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
    renderHook(() => useOmpPlanUsage('omp', 'auto'));
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
    renderHook(() => useOmpPlanUsage('omp', 'auto'));

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
      ({ provider }) => useOmpPlanUsage(provider, 'auto'),
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
      ({ provider }) => useOmpPlanUsage(provider, 'auto'),
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
    const { unmount } = renderHook(() => useOmpPlanUsage('omp', 'auto'));

    w.sendToJava = vi.fn();
    act(() => {
      window.dispatchEvent(new Event(BRIDGE_READY_EVENT));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
    expect(w.sendToJava).toHaveBeenCalledWith('get_omp_plan_usage:auto');

    unmount();
    act(() => {
      window.dispatchEvent(new Event(BRIDGE_READY_EVENT));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous present reading on a JSON parse error and backs off at 20s', () => {
    vi.useFakeTimers();
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useOmpPlanUsage('omp', 'auto'));

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

  describe('model changes', () => {
    const opus = 'anthropic/claude-opus-5-5';
    const gpt = 'openai/gpt-5.5';

    it('polls the new model at once from the 30-minute step and restarts the backoff', () => {
      vi.useFakeTimers();
      w.sendToJava = vi.fn();
      const { rerender } = renderHook(
        ({ model }) => useOmpPlanUsage('omp', model),
        { initialProps: { model: opus } },
      );
      expect(w.sendToJava).toHaveBeenLastCalledWith(`get_omp_plan_usage:${opus}`);

      const fail = () => act(() => {
        w.updateOmpPlanUsage?.(JSON.stringify(unavailablePayload));
      });
      for (const delayMs of [20_000, 60_000, 300_000]) {
        fail();
        act(() => {
          vi.advanceTimersByTime(delayMs);
        });
      }
      // The fourth failure schedules the 30-minute retry.
      fail();
      expect(w.sendToJava).toHaveBeenCalledTimes(4);

      rerender({ model: gpt });
      expect(w.sendToJava).toHaveBeenCalledTimes(5);
      expect(w.sendToJava).toHaveBeenLastCalledWith(`get_omp_plan_usage:${gpt}`);

      // The first failure of the new model waits 20s again, and the old 30-minute timer is gone.
      fail();
      act(() => {
        vi.advanceTimersByTime(19_999);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(5);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(6);
    });

    it('hides the previous model\'s limits until the new model answers', () => {
      w.sendToJava = vi.fn();
      const { result, rerender } = renderHook(
        ({ model }) => useOmpPlanUsage('omp', model),
        { initialProps: { model: opus } },
      );
      act(() => {
        w.updateOmpPlanUsage?.(JSON.stringify({ ...presentPayload, requested_model: opus }));
      });
      expect(result.current.status).toBe('ready');
      expect(result.current.snapshot?.capacityPct).toBe(10);

      rerender({ model: gpt });
      expect(result.current.status).toBe('idle');
      expect(result.current.snapshot).toBeNull();

      act(() => {
        w.updateOmpPlanUsage?.(JSON.stringify({ ...presentPayload, capacity_pct: 42, requested_model: gpt }));
      });
      expect(result.current.status).toBe('ready');
      expect(result.current.snapshot?.capacityPct).toBe(42);
    });

    it('ignores a late reply for the previous model that arrives after the new request', () => {
      w.sendToJava = vi.fn();
      const { result, rerender } = renderHook(
        ({ model }) => useOmpPlanUsage('omp', model),
        { initialProps: { model: opus } },
      );

      rerender({ model: gpt });
      expect(w.sendToJava).toHaveBeenCalledTimes(2);
      act(() => {
        w.updateOmpPlanUsage?.(JSON.stringify({ ...presentPayload, capacity_pct: 90, requested_model: opus }));
      });
      expect(result.current.status).toBe('idle');
      expect(result.current.snapshot).toBeNull();

      act(() => {
        w.updateOmpPlanUsage?.(JSON.stringify({ ...presentPayload, capacity_pct: 42, requested_model: gpt }));
      });
      expect(result.current.snapshot?.capacityPct).toBe(42);
    });

    it('does not poll for a model change while the provider is not omp', () => {
      w.sendToJava = vi.fn();
      const { rerender } = renderHook(
        ({ model }) => useOmpPlanUsage('claude', model),
        { initialProps: { model: opus } },
      );
      rerender({ model: gpt });
      expect(w.sendToJava).not.toHaveBeenCalled();
    });
  });
});
