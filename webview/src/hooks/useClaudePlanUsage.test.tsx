import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useClaudePlanUsage } from './useClaudePlanUsage';

const w = window as unknown as {
  sendToJava?: (cmd: string) => void;
  updateClaudePlanUsage?: (json: string) => void;
};

const unavailablePayload = {
  present: false,
  unavailable: true,
  message: 'Claude usage unavailable',
};

const presentPayload = {
  ok: true,
  present: true,
  provider: 'claude',
  source: 'sdk-rate-limit',
  capacity_pct: 42,
  reset_at: '2026-08-23T03:00:00Z',
  period_type: '5h',
  windows: [
    { id: '5h', used_pct: 42, reset_at: '2026-08-23T03:00:00Z', period_type: '5h' },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  delete w.sendToJava;
  delete w.updateClaudePlanUsage;
});

describe('useClaudePlanUsage', () => {
  it('stays hidden (idle) while no event has ever arrived', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useClaudePlanUsage('claude'));
    expect(w.sendToJava).toHaveBeenCalledWith('get_claude_plan_usage:');

    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('becomes ready on the first present payload, then keeps data visible', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useClaudePlanUsage('claude'));

    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.capacityPct).toBe(42);

    // Later unavailable poll after data was seen → dash, not hidden.
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('unavailable');
    expect(result.current.snapshot?.present).toBe(false);
  });

  it('is empty for non-claude providers and never polls', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useClaudePlanUsage('gemini'));
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
    expect(w.sendToJava).not.toHaveBeenCalled();
  });
});
