import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRuntimeProviderDispatchers } from '../utils/runtimeProviderCapabilities';
import { useClaudePlanUsage } from './useClaudePlanUsage';

const w = window as unknown as {
  sendToJava?: (cmd: string) => void;
  updateClaudePlanUsage?: (json: string) => void;
  updateActiveProvider?: (json: string) => void;
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
  delete w.updateActiveProvider;
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

  it('re-polls immediately when the active Claude provider changes', () => {
    installRuntimeProviderDispatchers();
    w.sendToJava = vi.fn();
    renderHook(() => useClaudePlanUsage('claude'));
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    // First update also re-polls: after a remount (e.g. returning from
    // settings) the ref starts null and this push may itself be a switch.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-a', isActive: true }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);

    // Same provider pushed again → no duplicate poll.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-a', isActive: true }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);

    // Provider switch → immediate re-poll.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-b', isActive: true }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(3);
    expect(w.sendToJava).toHaveBeenLastCalledWith('get_claude_plan_usage:');
  });

  it('hides the indicator after switching to a provider without usage data', () => {
    installRuntimeProviderDispatchers();
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useClaudePlanUsage('claude'));

    // Baseline provider with usage data → bar visible.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-a', isActive: true }));
    });
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');

    // Switch to a provider without usage integration → old snapshot is dropped.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-b', isActive: true }));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();

    // Backend answers unavailable → stay hidden, no "Usage —" dash.
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('hides the bar when a switch and its unavailable response land in the same render batch', () => {
    installRuntimeProviderDispatchers();
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useClaudePlanUsage('claude'));

    // Baseline provider with usage data → bar visible.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-a', isActive: true }));
    });
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');

    // Rapid switch + unavailable response within the same React render batch:
    // the EMPTY reset queued before refresh() must still win.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-b', isActive: true }));
      w.updateClaudePlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('re-polls when the switch push is the first event after a settings remount', () => {
    installRuntimeProviderDispatchers();
    w.sendToJava = vi.fn();
    const { result, unmount } = renderHook(() => useClaudePlanUsage('claude'));

    // First session: usage provider with data → bar visible.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-a', isActive: true }));
    });
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');

    // Settings route unmounts the chat view (and this hook); the provider
    // switch made in settings was pushed while no subscription existed.
    unmount();
    const { result: remounted } = renderHook(() => useClaudePlanUsage('claude'));

    // The first push after remount is the dropdown switch to a provider
    // without usage integration — it must drop stale data and re-poll.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-no-usage', isActive: true }));
    });
    expect(remounted.current.status).toBe('idle');
    expect(remounted.current.snapshot).toBeNull();

    // Backend answers unavailable → stays hidden, no "Usage —" dash.
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(remounted.current.status).toBe('idle');
    expect(remounted.current.snapshot).toBeNull();
  });
});
