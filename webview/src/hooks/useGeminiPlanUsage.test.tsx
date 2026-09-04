import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGeminiPlanUsage } from './useGeminiPlanUsage';
import { resolveDisplayWindow, type CapacityWindow } from '../utils/planUsagePace';

const w = window as unknown as {
  sendToJava?: (cmd: string) => void;
  updateGeminiPlanUsage?: (json: string) => void;
};

const unavailablePayload = {
  present: false,
  unavailable: true,
  provider: 'gemini',
  message: 'Gemini usage unavailable',
};

// Live-shaped quota payload (agy /usage, spec external-cli-behaviors.md):
// the Java service maps command.data.groups for the SELECTED model's billing
// family onto the shared capacity shape. AC3 markers: num_turns 0, empty
// conversation_id, all-zero usage — the probe is not a model turn.
const presentPayload = {
  ok: true,
  present: true,
  provider: 'gemini',
  source: 'agy-usage',
  capacity_pct: 58,
  reset_at: '2026-09-08T18:15:00Z',
  period_type: '5h',
  windows: [
    { id: 'gemini-5h', used_pct: 58, reset_at: '2026-09-08T18:15:00Z', period_type: '5h' },
    { id: 'gemini-weekly', used_pct: 23.83, reset_at: '2026-09-10T20:06:55Z', period_type: 'weekly' },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  delete w.sendToJava;
  delete w.updateGeminiPlanUsage;
});

describe('useGeminiPlanUsage', () => {
  it('stays hidden (idle) while no payload has ever arrived', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() =>
      useGeminiPlanUsage('gemini', 'gemini-3.7-flash-high'));
    expect(w.sendToJava).toHaveBeenCalledWith('get_gemini_plan_usage:gemini-3.7-flash-high');

    act(() => {
      w.updateGeminiPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('becomes ready on the first present payload, then keeps data visible', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() =>
      useGeminiPlanUsage('gemini', 'gemini-3.7-flash-high'));

    act(() => {
      w.updateGeminiPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.capacityPct).toBe(58);
    expect(result.current.snapshot?.provider).toBe('gemini');

    // Later unavailable poll after data was seen → dash, not hidden.
    act(() => {
      w.updateGeminiPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('unavailable');
    expect(result.current.snapshot?.present).toBe(false);
  });

  it('is empty for non-gemini providers and never polls', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() =>
      useGeminiPlanUsage('claude', 'claude-sonnet-4-6'));
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
    expect(w.sendToJava).not.toHaveBeenCalled();
  });

  it('carries the selected model slug on the poll so the family follows the selection', () => {
    w.sendToJava = vi.fn();
    const { rerender } = renderHook(
      ({ model }) => useGeminiPlanUsage('gemini', model),
      { initialProps: { model: 'gemini-3.7-flash-high' } },
    );
    expect(w.sendToJava).toHaveBeenLastCalledWith('get_gemini_plan_usage:gemini-3.7-flash-high');

    // Switch to the other billing family → the next poll asks for THAT family
    rerender({ model: 'claude-sonnet-4-6' });
    expect(w.sendToJava).toHaveBeenLastCalledWith('get_gemini_plan_usage:claude-sonnet-4-6');
  });

  it('exposes the family windows for the shared window switcher (5h vs weekly)', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() =>
      useGeminiPlanUsage('gemini', 'gemini-3.7-flash-high'));

    act(() => {
      w.updateGeminiPlanUsage?.(JSON.stringify(presentPayload));
    });
    const snapshot = result.current.snapshot;
    expect(snapshot?.windows?.map((win: CapacityWindow) => win.id))
      .toEqual(['gemini-5h', 'gemini-weekly']);
    expect(resolveDisplayWindow(snapshot!, 'gemini-5h').capacityPct).toBe(58);
    expect(resolveDisplayWindow(snapshot!, 'gemini-weekly').capacityPct).toBe(23.83);
  });
});
