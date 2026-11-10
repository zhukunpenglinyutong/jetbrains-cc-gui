import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSupplierSelect } from './SessionSupplierSelect';
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
  delete window.sendToJava;
  localStorage.clear();
});

describe('session supplier selection', () => {
  it('selects only for this conversation and shows deferred application during a turn', async () => {
    render(<SessionSupplierSelect provider="claude" busy />);
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    const [type, payload] = bridge.mock.calls.at(-1) ?? [];
    expect(type).toBe('set_session_supplier');
    expect(JSON.parse(payload as string)).toMatchObject({ provider: 'claude', supplierId: 'b', sessionId: 'history-a', bindingToken: 'binding-a' });
    reply({ supplierId: 'b', activeSupplierId: 'a', busy: true });
    expect(screen.getByRole('status').textContent).toBe('Applies to the next turn');
    expect(bridge.mock.calls.some(([event]) => event === 'switch_provider')).toBe(false);
  });

  it('preserves an unavailable historical binding without auto-selecting another supplier', async () => {
    render(<SessionSupplierSelect provider="codex" busy={false} />);
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply({ supplierId: 'deleted', activeSupplierId: 'deleted' });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('deleted');
    expect(screen.getByRole('status').textContent).toBe('Select a supplier');
    expect(bridge.mock.calls.every(([event]) => event === 'get_session_suppliers')).toBe(true);
  });

  it('publishes safe Codex binding metadata for the native catalog consumer', async () => {
    const received = vi.fn();
    window.addEventListener('session-supplier-snapshot', received);
    try {
      render(<SessionSupplierSelect provider="codex" busy={false} />);
      await waitFor(() => expect(bridge).toHaveBeenCalled());
      reply({ supplierId: 'b', busy: true });
      const detail = (received.mock.calls.at(-1)?.[0] as CustomEvent<unknown>).detail;
      expect(detail).toEqual({ provider: 'codex', supplierId: 'b', bindingToken: 'binding-a', busy: true });
    } finally {
      window.removeEventListener('session-supplier-snapshot', received);
    }
  });

  it('ignores old history responses and keeps model labels local to the webview', async () => {
    const view = render(<SessionSupplierSelect provider="claude" busy={false} />);
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    const oldRequest = JSON.parse(bridge.mock.calls.at(-1)?.[1] as string) as { provider: string; requestId: string };
    session.currentSessionId = 'history-b';
    view.rerender(<SessionSupplierSelect provider="claude" busy={false} />);
    await waitFor(() => expect(JSON.parse(bridge.mock.calls.at(-1)?.[1] as string).requestId).not.toBe(oldRequest.requestId));
    reply({ supplierId: 'b', modelMappingEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'b-model' } });
    act(() => window.onSessionSuppliers?.(JSON.stringify({ ...oldRequest, suppliers, supplierId: 'a' })));
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('b');
    writeClaudeModelMapping({ sonnet: 'global-model' });
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'b-model' });
    expect(readGlobalClaudeModelMapping()).toEqual({ sonnet: 'global-model' });
    view.unmount();
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'global-model' });
  });

  it('allows retry after a failed bridge request', async () => {
    bridge.mockReturnValue(false);
    render(<SessionSupplierSelect provider="claude" busy={false} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Supplier unavailable'));
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('reloads a new unsaved conversation even when both session ids are null', async () => {
    session.currentSessionId = null;
    render(<SessionSupplierSelect provider="claude" busy={false} />);
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply({ supplierId: 'b', modelMappingEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'b-model' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a' } });
    const previous = JSON.parse(bridge.mock.calls.at(-1)?.[1] as string) as { provider: string; requestId: string };
    fireEvent(window, new Event('session-supplier-binding-changed'));
    expect(bridge.mock.calls.at(-1)?.[0]).toBe('get_session_suppliers');
    expect(getSessionClaudeModelCatalog()).toBeNull();
    act(() => window.onSessionSuppliers?.(JSON.stringify({ ...previous, suppliers, supplierId: 'b' })));
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    reply({ bindingToken: 'new-binding', supplierId: 'a' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(JSON.parse(bridge.mock.calls.at(-1)?.[1] as string)).toMatchObject({
      supplierId: 'b', sessionId: null, bindingToken: 'new-binding',
    });
  });

  it('keeps a pending selection authoritative across focus and busy refreshes', async () => {
    const view = render(<SessionSupplierSelect provider="claude" busy={false} />);
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    const selection = bridge.mock.calls.at(-1);
    fireEvent(window, new Event('focus'));
    view.rerender(<SessionSupplierSelect provider="claude" busy />);
    expect(bridge.mock.calls.at(-1)).toEqual(selection);
    reply({ supplierId: 'b', activeSupplierId: 'a', busy: true });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('b');
  });

  it('routes the thinking toggle through the selected conversation supplier and preserves the binding fence', async () => {
    const changed = vi.fn();
    render(<SessionSupplierSelect provider="claude" busy={false} onThinkingSettingsChange={changed} />);
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply({ supplierId: 'b', thinkingEnabled: false });
    const settings = changed.mock.calls.at(-1)?.[0] as { enabled: boolean; onChange: (value: boolean) => void };
    expect(settings.enabled).toBe(false);
    act(() => settings.onChange(true));
    expect(bridge.mock.calls.at(-1)?.[0]).toBe('set_session_supplier');
    expect(JSON.parse(bridge.mock.calls.at(-1)?.[1] as string)).toMatchObject({
      supplierId: 'b', thinkingEnabled: true, sessionId: 'history-a', bindingToken: 'binding-a',
    });
    expect(bridge.mock.calls.some(([event]) => event === 'update_provider' || event === 'set_thinking_enabled')).toBe(false);
  });

  it('publishes the selected supplier picker without retaining the previous conversation catalog', async () => {
    const view = render(<SessionSupplierSelect provider="claude" busy={false} />);
    await waitFor(() => expect(bridge).toHaveBeenCalled());
    reply({ supplierId: 'b', modelCatalog: { models: [{ id: 'b-route', label: 'B Route', supports1MContext: true }],
      defaultModel: 'b-route', replaceBuiltInOptions: true } });
    expect(getSessionClaudeModelCatalog()?.defaultModel).toBe('b-route');
    session.currentSessionId = 'history-b';
    view.rerender(<SessionSupplierSelect provider="claude" busy={false} />);
    expect(getSessionClaudeModelCatalog()).toBeNull();
    await waitFor(() => expect(bridge.mock.calls.at(-1)?.[0]).toBe('get_session_suppliers'));
    reply();
    expect(getSessionClaudeModelCatalog()?.models).toEqual([]);
  });
});
