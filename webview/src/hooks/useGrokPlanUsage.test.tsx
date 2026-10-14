import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('becomes ready on the first present payload, then keeps data visible', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useGrokPlanUsage('grok'));

    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.capacityPct).toBe(42.5);
    expect(result.current.snapshot?.level).toBe('SuperGrok');

    act(() => {
      w.updateGrokPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('unavailable');
    expect(result.current.snapshot?.present).toBe(false);
  });

  it('is empty for other providers and never polls', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useGrokPlanUsage('claude'));
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
    expect(w.sendToJava).not.toHaveBeenCalled();
  });
});
