import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_READY_EVENT } from '../utils/bridgeStartup';
import { useGrokPlanUsage } from './useGrokPlanUsage';

const w = window as unknown as {
  sendToJava?: (cmd: string) => void;
  updateGrokPlanUsage?: (json: string) => void;
};

const unavailablePayload = {
  present: false,
  unavailable: true,
  message: 'Grok usage unavailable',
};

const presentPayload = {
  ok: true,
  present: true,
  provider: 'grok',
  source: 'x.ai/billing',
  level: 'SuperGrok',
  capacity_pct: 42.5,
  reset_at: '2026-06-08T00:00:00Z',
  period_start: '2026-06-01T00:00:00Z',
  period_type: 'USAGE_PERIOD_TYPE_WEEKLY',
  windows: [
    {
      id: 'USAGE_PERIOD_TYPE_WEEKLY',
      used_pct: 42.5,
      reset_at: '2026-06-08T00:00:00Z',
      period_type: 'USAGE_PERIOD_TYPE_WEEKLY',
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  delete w.sendToJava;
  delete w.updateGrokPlanUsage;
});

describe('useGrokPlanUsage', () => {
  it('stays hidden while billing has never arrived', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useGrokPlanUsage('grok'));
    expect(w.sendToJava).toHaveBeenCalledWith('get_grok_plan_usage:');

    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('stays ready on a stale payload and polls again at 20s', () => {
    vi.useFakeTimers();
    try {
      w.sendToJava = vi.fn();
      const { result } = renderHook(() => useGrokPlanUsage('grok'));

      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify({ ...presentPayload, stale: true }));
      });
      expect(result.current.status).toBe('ready');
      expect(result.current.snapshot?.capacityPct).toBe(42.5);
      expect(result.current.snapshot?.stale).toBe(true);

      act(() => {
        vi.advanceTimersByTime(19_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides the chip when a present payload is followed by unavailable', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useGrokPlanUsage('grok'));

    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');

    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('is empty for other providers and never polls', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useGrokPlanUsage('claude'));
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
    expect(w.sendToJava).not.toHaveBeenCalled();
  });

  it('rechecks every 5 minutes while skipPolling is true and shows the bar after a switch to OAuth', () => {
    vi.useFakeTimers();
    try {
      w.sendToJava = vi.fn();
      const { result } = renderHook(() => useGrokPlanUsage('grok'));
      expect(w.sendToJava).toHaveBeenCalledTimes(1);
      expect(w.sendToJava).toHaveBeenCalledWith('get_grok_plan_usage:');

      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify({
          present: false,
          unavailable: true,
          skipPolling: true,
          message: 'Grok usage unavailable',
        }));
      });
      expect(result.current.status).toBe('idle');
      expect(result.current.snapshot).toBeNull();

      // No 20s/60s polling for api_key auth
      act(() => {
        vi.advanceTimersByTime(299_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(2);

      // The user switched to OAuth in Settings while staying on Grok
      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(presentPayload));
      });
      expect(result.current.status).toBe('ready');
      expect(result.current.snapshot?.capacityPct).toBe(42.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the 60s cadence while dormant and does not climb the failure ladder', () => {
    vi.useFakeTimers();
    try {
      w.sendToJava = vi.fn();
      const { result } = renderHook(() => useGrokPlanUsage('grok'));

      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(presentPayload));
      });

      // The daemon idle-exited: Java repeats the last reading as stale + dormant
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(2);
      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify({ ...presentPayload, stale: true, dormant: true }));
      });
      expect(result.current.status).toBe('ready');
      expect(result.current.snapshot?.stale).toBe(true);

      for (let i = 0; i < 3; i += 1) {
        act(() => {
          vi.advanceTimersByTime(59_000);
        });
        expect(w.sendToJava).toHaveBeenCalledTimes(2 + i);
        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        expect(w.sendToJava).toHaveBeenCalledTimes(3 + i);
        act(() => {
          w.updateGrokPlanUsage?.(JSON.stringify({ ...unavailablePayload, dormant: true }));
        });
        expect(result.current.status).toBe('idle');
      }

      // A real failure after dormant ticks still starts the ladder at 20s
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(6);
      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
      });
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again in 20s without climbing the ladder while another window refreshes', () => {
    vi.useFakeTimers();
    try {
      w.sendToJava = vi.fn();
      const { result } = renderHook(() => useGrokPlanUsage('grok'));

      // A failure first, so the next real failure would wait 60s
      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
      });
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(2);

      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify({ ...presentPayload, stale: true, refreshing: true }));
      });
      expect(result.current.status).toBe('ready');
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(3);

      // The ladder did not move: the next failure still waits 60s
      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
      });
      act(() => {
        vi.advanceTimersByTime(59_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(3);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a failure streak on a dormant reply', () => {
    vi.useFakeTimers();
    try {
      w.sendToJava = vi.fn();
      renderHook(() => useGrokPlanUsage('grok'));

      // Two failures climb the ladder to the 5m step
      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
      });
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(3);

      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify({ ...unavailablePayload, dormant: true }));
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(4);

      // The next failure starts over at 20s, not 5m
      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
      });
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls again when a reply never arrives', () => {
    vi.useFakeTimers();
    try {
      w.sendToJava = vi.fn();
      const { result } = renderHook(() => useGrokPlanUsage('grok'));
      expect(w.sendToJava).toHaveBeenCalledTimes(1);

      // The first reply is lost
      act(() => {
        vi.advanceTimersByTime(119_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(2);

      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(presentPayload));
      });
      expect(result.current.status).toBe('ready');

      // A reply replaces the watchdog with the normal 60s tick
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows the failure ladder 20s -> 1m -> 5m -> 30m and resets on success', () => {
    vi.useFakeTimers();
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useGrokPlanUsage('grok'));
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    // Failure 1 -> schedules next poll at 20s
    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    // Advance 19s: no poll yet
    act(() => {
      vi.advanceTimersByTime(19_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    // Advance to 20s: poll fires (attempt 2)
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);

    // Failure 2 -> schedules next poll at 60s (1m)
    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);

    // Advance 59s: no poll yet
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);

    // Advance to 60s: poll fires (attempt 3)
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(3);

    // Failure 3 -> schedules next poll at 300s (5m)
    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(3);

    // Advancing 60 seconds does not send
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(3);

    // Advancing remaining 240s (reaching 5m step) sends once (attempt 4)
    act(() => {
      vi.advanceTimersByTime(240_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(4);

    // Failure 4 -> schedules next poll at 1800s (30m)
    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(4);

    // Advance 1799s: no poll yet
    act(() => {
      vi.advanceTimersByTime(1_799_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(4);

    // Advance to 1800s (30m): poll fires (attempt 5)
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(5);

    // Failure 5 -> caps at 1800s (30m), does not grow past 30m
    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(5);

    act(() => {
      vi.advanceTimersByTime(1_799_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(5);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(6);

    // A present payload resets next delay to 60s and resets failureStep to 0
    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');

    // Advance 59s: no poll yet
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(6);

    // Advance to 60s: poll fires (attempt 7)
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(7);

    // A failure after a present payload starts the ladder over at 20s
    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    act(() => {
      vi.advanceTimersByTime(19_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(7);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(8);

    vi.useRealTimers();
  });

  it('continues scheduled polling after switching currentProvider from claude to grok', () => {
    vi.useFakeTimers();
    w.sendToJava = vi.fn();
    const { rerender } = renderHook(
      ({ provider }) => useGrokPlanUsage(provider),
      { initialProps: { provider: 'claude' } },
    );
    expect(w.sendToJava).not.toHaveBeenCalled();

    rerender({ provider: 'grok' });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(presentPayload));
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('polls on BRIDGE_READY_EVENT when sendToJava was not installed at mount', () => {
    delete w.sendToJava;
    const { unmount } = renderHook(() => useGrokPlanUsage('grok'));

    w.sendToJava = vi.fn();
    act(() => {
      window.dispatchEvent(new Event(BRIDGE_READY_EVENT));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
    expect(w.sendToJava).toHaveBeenCalledWith('get_grok_plan_usage:');

    unmount();
    act(() => {
      window.dispatchEvent(new Event(BRIDGE_READY_EVENT));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous present reading on a JSON parse error and backs off at 20s', () => {
    vi.useFakeTimers();
    try {
      w.sendToJava = vi.fn();
      const { result } = renderHook(() => useGrokPlanUsage('grok'));
      expect(w.sendToJava).toHaveBeenCalledTimes(1);

      act(() => {
        w.updateGrokPlanUsage?.(JSON.stringify(presentPayload));
      });
      expect(result.current.status).toBe('ready');
      expect(result.current.snapshot?.capacityPct).toBe(42.5);

      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(2);

      act(() => {
        w.updateGrokPlanUsage?.('{malformed json');
      });
      expect(result.current.status).toBe('ready');
      expect(result.current.snapshot?.capacityPct).toBe(42.5);

      act(() => {
        vi.advanceTimersByTime(19_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(2);

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(w.sendToJava).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

