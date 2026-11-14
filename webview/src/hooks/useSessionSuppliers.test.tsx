import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionSuppliers } from './useSessionSuppliers';
import { readClaudeModelMapping, readGlobalClaudeModelMapping, writeClaudeModelMapping } from '../utils/claudeModelMapping';
import { getSessionClaudeModelCatalog } from '../utils/sessionClaudeModelCatalog';

const bridge = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ currentSessionId: 'history-a' as string | null }));
vi.mock('../utils/bridge', () => ({ sendBridgeEvent: bridge }));
vi.mock('../contexts/SessionContext', () => ({ useSession: () => session }));
vi.mock('../contexts/UIStateContext', () => ({ useUIState: () => ({ currentView: 'chat' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));

const suppliers = [
  { id: 'a', name: 'Supplier A', available: true },
  { id: 'b', name: 'Supplier B', available: true },
];

function reply(data: Record<string, unknown> = {}) {
  const call = bridge.mock.calls.at(-1);
  const request = JSON.parse(call?.[1] as string) as { provider: string; requestId: string };
  act(() => window.onSessionSuppliers?.(JSON.stringify({ ...request, suppliers, supplierId: 'a', activeSupplierId: 'a',
    sessionId: session.currentSessionId, bindingToken: 'binding-a', ...data })));
}

beforeEach(() => {
  bridge.mockReset();
  session.currentSessionId = 'history-a';
  window.sendToJava = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.sendToJava;
  localStorage.clear();
});

describe('session supplier selection', () => {
  it('selects only for this conversation and shows deferred application during a turn', async () => {
    const { result } = renderHook(() => useSessionSuppliers('claude', true));
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply();
    act(() => { void result.current.selectSupplier('b'); });
    const [type, payload] = bridge.mock.calls.at(-1) ?? [];
    expect(type).toBe('set_session_supplier');
    expect(JSON.parse(payload as string)).toMatchObject({ provider: 'claude', supplierId: 'b', sessionId: 'history-a', bindingToken: 'binding-a' });
    reply({ supplierId: 'b', activeSupplierId: 'a', busy: true });
    expect(result.current.deferred).toBe(true);
    expect(bridge.mock.calls.some(([event]) => event === 'switch_provider')).toBe(false);
  });

  it('preserves an unavailable historical binding without auto-selecting another supplier', async () => {
    const { result } = renderHook(() => useSessionSuppliers('codex', false));
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply({ supplierId: 'deleted', activeSupplierId: 'deleted' });
    expect(result.current.supplierId).toBe('deleted');
    expect(result.current.missing).toBe(true);
    expect(bridge.mock.calls.every(([event]) => event === 'get_session_suppliers')).toBe(true);
  });

  it('publishes safe Codex binding metadata for the native catalog consumer', async () => {
    const received = vi.fn();
    window.addEventListener('session-supplier-snapshot', received);
    try {
      renderHook(() => useSessionSuppliers('codex', false));
      await waitFor(() => expect(bridge).toHaveBeenCalled());
      reply({ supplierId: 'b', busy: true });
      const detail = (received.mock.calls.at(-1)?.[0] as CustomEvent<unknown>).detail;
      expect(detail).toEqual({ provider: 'codex', supplierId: 'b', bindingToken: 'binding-a', busy: true });
    } finally {
      window.removeEventListener('session-supplier-snapshot', received);
    }
  });

  it('ignores old history responses and keeps model labels local to the webview', async () => {
    const view = renderHook(({ busy }) => useSessionSuppliers('claude', busy), { initialProps: { busy: false } });
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    const oldRequest = JSON.parse(bridge.mock.calls.at(-1)?.[1] as string) as { provider: string; requestId: string };
    session.currentSessionId = 'history-b';
    view.rerender({ busy: false });
    await waitFor(() => expect(JSON.parse(bridge.mock.calls.at(-1)?.[1] as string).requestId).not.toBe(oldRequest.requestId));
    reply({ supplierId: 'b', modelMappingEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'b-model' } });
    act(() => window.onSessionSuppliers?.(JSON.stringify({ ...oldRequest, suppliers, supplierId: 'a' })));
    expect(view.result.current.supplierId).toBe('b');
    writeClaudeModelMapping({ sonnet: 'global-model' });
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'b-model' });
    expect(readGlobalClaudeModelMapping()).toEqual({ sonnet: 'global-model' });
    view.unmount();
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'global-model' });
  });

  it('allows retry after a failed bridge request', async () => {
    bridge.mockReturnValue(false);
    const { result } = renderHook(({ busy }) => useSessionSuppliers('claude', busy), { initialProps: { busy: false } });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.pending).toBe(false);
    bridge.mockReturnValue(undefined);
    act(() => result.current.refresh());
    reply();
    expect(result.current.error).toBe(false);
  });

  it('reloads a new unsaved conversation even when both session ids are null', async () => {
    session.currentSessionId = null;
    const { result } = renderHook(({ busy }) => useSessionSuppliers('claude', busy), { initialProps: { busy: false } });
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply({ supplierId: 'b', modelMappingEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'b-model' } });
    act(() => { void result.current.selectSupplier('a'); });
    const previous = JSON.parse(bridge.mock.calls.at(-1)?.[1] as string) as { provider: string; requestId: string };
    fireEvent(window, new Event('session-supplier-binding-changed'));
    expect(bridge.mock.calls.at(-1)?.[0]).toBe('get_session_suppliers');
    expect(getSessionClaudeModelCatalog()).toBeNull();
    act(() => window.onSessionSuppliers?.(JSON.stringify({ ...previous, suppliers, supplierId: 'b' })));
    expect(result.current.supplierId).toBeUndefined();
    reply({ bindingToken: 'new-binding', supplierId: 'a' });
    act(() => { void result.current.selectSupplier('b'); });
    expect(JSON.parse(bridge.mock.calls.at(-1)?.[1] as string)).toMatchObject({
      supplierId: 'b', sessionId: null, bindingToken: 'new-binding',
    });
  });

  it('keeps a pending selection authoritative across focus and busy refreshes', async () => {
    const view = renderHook(({ busy }) => useSessionSuppliers('claude', busy), { initialProps: { busy: false } });
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply();
    act(() => { void view.result.current.selectSupplier('b'); });
    const selection = bridge.mock.calls.at(-1);
    fireEvent(window, new Event('focus'));
    view.rerender({ busy: true });
    expect(bridge.mock.calls.at(-1)).toEqual(selection);
    reply({ supplierId: 'b', activeSupplierId: 'a', busy: true });
    expect(view.result.current.supplierId).toBe('b');
  });

  it('routes the thinking toggle through the selected conversation supplier and preserves the binding fence', async () => {
    const { result } = renderHook(() => useSessionSuppliers('claude', false));
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply({ supplierId: 'b', thinkingEnabled: false });
    const settings = result.current.thinkingSettings!;
    expect(settings.enabled).toBe(false);
    act(() => settings.onChange(true));
    expect(bridge.mock.calls.at(-1)?.[0]).toBe('set_session_supplier');
    expect(JSON.parse(bridge.mock.calls.at(-1)?.[1] as string)).toMatchObject({
      supplierId: 'b', thinkingEnabled: true, sessionId: 'history-a', bindingToken: 'binding-a',
    });
    expect(bridge.mock.calls.some(([event]) => event === 'update_provider' || event === 'set_thinking_enabled')).toBe(false);
  });

  it('publishes the selected supplier picker without retaining the previous conversation catalog', async () => {
    const view = renderHook(({ busy }) => useSessionSuppliers('claude', busy), { initialProps: { busy: false } });
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply({ supplierId: 'b', modelCatalog: { models: [{ id: 'b-route', label: 'B Route', supports1MContext: true }],
      defaultModel: 'b-route', replaceBuiltInOptions: true } });
    expect(getSessionClaudeModelCatalog()?.defaultModel).toBe('b-route');
    session.currentSessionId = 'history-b';
    view.rerender({ busy: false });
    expect(getSessionClaudeModelCatalog()).toBeNull();
    await waitFor(() => expect(bridge.mock.calls.at(-1)?.[0]).toBe('get_session_suppliers'));
    reply();
    expect(getSessionClaudeModelCatalog()?.models).toEqual([]);
  });

  it('settles a timed out choice as failed and ignores its late acknowledgement before retrying', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSessionSuppliers('codex', false));
    act(() => vi.advanceTimersByTime(0));
    reply();
    let outcome!: Promise<boolean>;
    act(() => { outcome = result.current.selectSupplier('b'); });
    const previous = JSON.parse(bridge.mock.calls.at(-1)?.[1] as string) as Record<string, unknown>;
    act(() => vi.advanceTimersByTime(10000));
    expect(await outcome).toBe(false);
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBe(true);
    act(() => window.onSessionSuppliers?.(JSON.stringify({ ...previous, supplierId: 'b' })));
    expect(result.current.supplierId).toBe('a');
    act(() => result.current.refresh());
    reply({ supplierId: 'b' });
    expect(result.current.supplierId).toBe('b');
    expect(result.current.error).toBe(false);
  });

  it('settles a pending choice as failed when its chat unmounts', async () => {
    const view = renderHook(() => useSessionSuppliers('codex', false));
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply();
    let outcome!: Promise<boolean>;
    act(() => { outcome = view.result.current.selectSupplier('b'); });
    view.unmount();
    expect(await outcome).toBe(false);
    expect(window.onSessionSuppliers).toBeUndefined();
  });
});
