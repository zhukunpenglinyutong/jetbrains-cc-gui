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
    expect(w.sendToJava).toHaveBeenCalledWith(expect.stringMatching(/^get_claude_plan_usage:\d+$/));

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

    // First push (settingsBootstrap's get_active_provider reply, not a
    // switch) must not clear or re-poll: the instance already polls with
    // current data, and clearing would blink a visible indicator.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-a', isActive: true }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    // Same provider pushed again → no duplicate poll.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-a', isActive: true }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    // Provider switch → immediate re-poll.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-b', isActive: true }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);
    expect(w.sendToJava).toHaveBeenLastCalledWith(expect.stringMatching(/^get_claude_plan_usage:\d+$/));
  });

  it('does not blink the indicator on the bootstrap first push after data arrived', () => {
    installRuntimeProviderDispatchers();
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useClaudePlanUsage('claude'));

    // Data arrives for the current provider → bar visible.
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');

    // The bootstrap push (~200ms after load) reports the same provider; the
    // indicator must stay ready instead of hiding and reappearing.
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-a', isActive: true }));
    });
    expect(result.current.status).toBe('ready');
  });

  it('ignores a late reply from the previous provider', () => {
    installRuntimeProviderDispatchers();
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useClaudePlanUsage('claude'));

    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-a', isActive: true }));
    });
    act(() => {
      w.updateActiveProvider?.(JSON.stringify({ id: 'provider-b', isActive: true }));
    });

    const sent = vi.mocked(w.sendToJava!).mock.calls
      .map(([cmd]) => cmd);
    const newestId = sent[sent.length - 1].slice('get_claude_plan_usage:'.length);
    const previousId = sent[sent.length - 2].slice('get_claude_plan_usage:'.length);

    // The new provider's reply arrives first.
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify({
        ...presentPayload,
        capacity_pct: 7,
        request_id: newestId,
      }));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.capacityPct).toBe(7);

    // The superseded poll's reply arrives late and must not overwrite it.
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify({
        ...presentPayload,
        capacity_pct: 99,
        request_id: previousId,
      }));
    });
    expect(result.current.snapshot?.capacityPct).toBe(7);
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

  it('a remount reads fresh data: stale same-id replies from the previous instance are dropped', () => {
    installRuntimeProviderDispatchers();
    w.sendToJava = vi.fn();
    const { unmount } = renderHook(() => useClaudePlanUsage('claude'));

    const idOf = (callIdx: number) => vi.mocked(w.sendToJava!).mock.calls[callIdx][0]
      .slice('get_claude_plan_usage:'.length);
    const firstInstanceId = idOf(0);

    // Settings route unmounts the chat view while the first poll is still in
    // flight; the remounted instance starts its own poll with a fresh
    // module-unique id (never restarts at 1).
    unmount();
    const { result: remounted } = renderHook(() => useClaudePlanUsage('claude'));
    const secondInstanceId = idOf(1);
    expect(secondInstanceId).not.toBe(firstInstanceId);

    // The slow reply to the first instance's poll arrives late; its stale
    // request_id must be dropped instead of surfacing as the new instance's data.
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify({
        ...presentPayload,
        capacity_pct: 99,
        request_id: firstInstanceId,
      }));
    });
    expect(remounted.current.status).toBe('idle');

    // The remounted instance's own reply is accepted.
    act(() => {
      w.updateClaudePlanUsage?.(JSON.stringify({
        ...presentPayload,
        capacity_pct: 7,
        request_id: secondInstanceId,
      }));
    });
    expect(remounted.current.status).toBe('ready');
    expect(remounted.current.snapshot?.capacityPct).toBe(7);
  });
});
