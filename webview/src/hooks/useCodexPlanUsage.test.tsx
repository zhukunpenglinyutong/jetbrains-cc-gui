import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_READY_EVENT } from '../utils/bridgeStartup';
import { installRuntimeProviderDispatchers } from '../utils/runtimeProviderCapabilities';
import { useCodexPlanUsage } from './useCodexPlanUsage';

const w = window as unknown as {
  sendToJava?: (cmd: string) => void;
  updateCodexPlanUsage?: (json: string) => void;
  updateActiveCodexProvider?: (json: string) => void;
};

const unavailablePayload = {
  present: false,
  unavailable: true,
  provider: 'codex',
  message: 'Codex usage unavailable',
};

const apiKeyModePayload = {
  present: false,
  unavailable: true,
  provider: 'codex',
  reason_code: 'api_key_mode',
  message: 'API key mode has no subscription quota',
};

const presentPayload = {
  ok: true,
  present: true,
  provider: 'codex',
  source: 'wham_usage',
  level: 'pro',
  capacity_pct: 24,
  reset_at: '2026-12-03T07:00:00Z',
  period_type: '7d',
  windows: [
    { id: '7d', used_pct: 24, reset_at: '2026-12-03T07:00:00Z', period_type: '7d' },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  delete w.sendToJava;
  delete w.updateCodexPlanUsage;
  delete w.updateActiveCodexProvider;
});

describe('useCodexPlanUsage', () => {
  it('stays hidden (idle) while no present payload has arrived', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useCodexPlanUsage('codex'));
    expect(w.sendToJava).toHaveBeenCalledWith(expect.stringMatching(/^get_codex_plan_usage:\d+$/));

    act(() => {
      w.updateCodexPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('becomes ready on present payload, shows unavailable on transient failure, and hides on api_key_mode', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useCodexPlanUsage('codex'));

    act(() => {
      w.updateCodexPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.capacityPct).toBe(24);
    expect(result.current.snapshot?.level).toBe('pro');

    act(() => {
      w.updateCodexPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('unavailable');

    act(() => {
      w.updateCodexPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');

    act(() => {
      w.updateCodexPlanUsage?.(JSON.stringify(apiKeyModePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('is empty for non-codex providers and never polls', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useCodexPlanUsage('claude'));
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
    expect(w.sendToJava).not.toHaveBeenCalled();
  });

  it('ignores stale replies with a mismatched request_id', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useCodexPlanUsage('codex'));

    act(() => {
      w.updateCodexPlanUsage?.(JSON.stringify({ ...presentPayload, request_id: '999999' }));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('re-polls immediately when the active Codex provider changes', () => {
    installRuntimeProviderDispatchers();
    w.sendToJava = vi.fn();
    renderHook(() => useCodexPlanUsage('codex'));
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    // First push (bootstrap) must not trigger a duplicate poll.
    act(() => {
      w.updateActiveCodexProvider?.(JSON.stringify({ id: '__codex_cli_login__' }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    // Same id re-push → no duplicate poll.
    act(() => {
      w.updateActiveCodexProvider?.(JSON.stringify({ id: '__codex_cli_login__' }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    // Provider switch → immediate re-poll.
    act(() => {
      w.updateActiveCodexProvider?.(JSON.stringify({ id: 'relay-provider' }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);
    expect(w.sendToJava).toHaveBeenLastCalledWith(expect.stringMatching(/^get_codex_plan_usage:\d+$/));
  });

  it('re-polls when this conversation switches Codex supplier once live', () => {
    w.sendToJava = vi.fn();
    renderHook(() => useCodexPlanUsage('codex'));
    const snapshot = (supplierId: string, busy = false, provider = 'codex') => act(() => {
      window.dispatchEvent(new CustomEvent('session-supplier-snapshot', { detail: { provider, supplierId, busy } }));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
    snapshot('__codex_cli_login__');
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
    snapshot('relay-provider', true);
    snapshot('relay-provider', false, 'claude');
    expect(w.sendToJava).toHaveBeenCalledTimes(1);
    snapshot('relay-provider');
    expect(w.sendToJava).toHaveBeenCalledTimes(2);
    snapshot('relay-provider');
    expect(w.sendToJava).toHaveBeenCalledTimes(2);
  });

  it('re-polls when BRIDGE_READY_EVENT fires', () => {
    w.sendToJava = vi.fn();
    renderHook(() => useCodexPlanUsage('codex'));
    expect(w.sendToJava).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event(BRIDGE_READY_EVENT));
    });
    expect(w.sendToJava).toHaveBeenCalledTimes(2);
  });
});
