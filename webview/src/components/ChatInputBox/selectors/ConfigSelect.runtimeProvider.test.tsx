import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSelect } from './ConfigSelect';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import { SessionSupplierContext } from '../../../contexts/SessionSupplierContext';
import { useSessionSuppliers } from '../../../hooks/useSessionSuppliers';

const session = vi.hoisted(() => ({ currentSessionId: 'history-a' as string | null }));
vi.mock('../../../contexts/SessionContext', () => ({ useSession: () => session }));
vi.mock('../../../contexts/UIStateContext', () => ({ useUIState: () => ({ currentView: 'chat' }) }));

function SessionMenu({ provider = 'claude', busy = false, onToggleThinking }: { provider?: string; busy?: boolean; onToggleThinking?: (enabled: boolean) => void }) {
  const supplier = useSessionSuppliers(provider, busy);
  return <SessionSupplierContext.Provider value={supplier}><ConfigSelect currentProvider={provider} alwaysThinkingEnabled={supplier.thinkingSettings?.enabled} onToggleThinking={onToggleThinking ?? supplier.thinkingSettings?.onChange} /></SessionSupplierContext.Provider>;
}

function requests() {
  return vi.mocked(window.sendToJava!).mock.calls.map(([message]) => message).filter(message => /^(get_session_suppliers|set_session_supplier):/.test(message));
}

function lastRequest() {
  return JSON.parse(requests().at(-1)!.split(':').slice(1).join(':')) as Record<string, unknown>;
}

function reply(data: Record<string, unknown> = {}) {
  act(() => window.onSessionSuppliers?.(JSON.stringify({ ...lastRequest(), sessionId: session.currentSessionId,
    bindingToken: 'binding-a', supplierId: 'a', activeSupplierId: 'a', suppliers: [
      { id: 'a', name: 'Provider A', available: true }, { id: 'b', name: 'Provider B', available: true },
    ], ...data })));
}

async function openSupplierMenu(data: Record<string, unknown> = {}) {
  await waitFor(() => expect(requests().length).toBeGreaterThan(0));
  reply(data);
  fireEvent.click(screen.getByRole('button', { name: /Configure/i }));
  const item = screen.getByRole('menuitem', { name: 'Switch provider' });
  expect(item.previousElementSibling?.className).toContain('selector-divider');
  expect(item.nextElementSibling?.className).toContain('selector-divider');
  fireEvent.mouseEnter(item);
  reply(data);
  return screen.getByRole('listbox');
}

vi.mock('antd', () => ({
  Switch: ({ checked, onClick }: { checked?: boolean; onClick?: (checked: boolean, e: { stopPropagation: () => void }) => void }) => (
    <button type="button" aria-pressed={checked} onClick={() => onClick?.(!checked, { stopPropagation: vi.fn() })} />
  ),
}));

vi.mock('../providers/agentProvider', () => ({
  CREATE_NEW_AGENT_ID: '__create__',
  EMPTY_STATE_ID: '__empty__',
  agentProvider: vi.fn(async () => []),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, string>) => ({
      'settings.configure': 'Configure',
      'settings.agent.title': 'Agent',
      'settings.basic.streaming.label': 'Streaming',
      'common.thinking': 'Thinking',
      'config.runtimeProvider.title': 'Switch provider',
      'config.runtimeProvider.empty': 'No providers',
      'config.runtimeProvider.loading': 'Loading providers',
      'config.runtimeProvider.switched': 'Provider switched',
      'config.nodeProcesses.title': 'Node processes',
      'settings.provider.localProviderName': 'Use local settings.json',
      'settings.provider.cliLoginProviderName': 'Use CLI login',
      'settings.codexProvider.dialog.cliLoginProviderName': 'Use local Codex config',
    } as Record<string, string>)[key] ?? (typeof options === 'string' ? options : key),
  }),
}));

function rect(left: number, right: number, width = right - left): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right,
    top: 0,
    bottom: 200,
    width,
    height: 200,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('ConfigSelect runtime provider submenu', () => {
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn> | undefined;
  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    session.currentSessionId = 'history-a';
    window.sendToJava = vi.fn();
    window.updateProviders = undefined;
    window.updateCodexProviders = undefined;
    window.updateActiveProvider = undefined;
    window.updateActiveCodexProvider = undefined;
  });

  afterEach(() => {
    getBoundingClientRectSpy?.mockRestore();
    getBoundingClientRectSpy = undefined;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
  });

  it('disables thinking until the supplier snapshot is usable and recovers after a read failure', async () => {
    const changed = vi.fn();
    render(<SessionMenu onToggleThinking={changed} />);
    fireEvent.click(screen.getByRole('button', { name: /Configure/i }));
    const row = screen.getByRole('button', { name: /Thinking/i });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(changed).not.toHaveBeenCalled();
    await waitFor(() => expect(requests().length).toBeGreaterThan(0));
    reply({ error: 'Unavailable' });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row);
    expect(changed).not.toHaveBeenCalled();
    fireEvent(window, new Event('focus'));
    reply({ thinkingEnabled: false });
    expect(row.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(row);
    expect(changed).toHaveBeenCalledWith(true);
  });

  it.each(['claude', 'codex'])('changes only the %s conversation after backend confirmation', async provider => {
    render(<SessionMenu provider={provider} />);
    const localId = provider === 'codex' ? SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN : SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS;
    const data = { suppliers: [{ id: localId, name: 'hidden native', available: true },
      { id: 'proxy-a', name: 'Proxy A', available: true }], supplierId: localId, activeSupplierId: localId };
    const submenu = await openSupplierMenu(data);
    expect(within(submenu).getByText(provider === 'codex' ? 'Use local Codex config' : 'Use local settings.json')).toBeTruthy();
    expect(within(submenu).getByRole('option', { selected: true }).textContent).not.toContain('Proxy A');
    const count = requests().length;
    fireEvent.click(within(submenu).getByRole('option', { name: 'Proxy A' }));
    expect(requests()).toHaveLength(count + 1);
    expect(requests().at(-1)).toMatch(/^set_session_supplier:/);
    expect(lastRequest()).toMatchObject({ provider, supplierId: 'proxy-a', sessionId: 'history-a', bindingToken: 'binding-a' });
    expect(screen.queryByText('Provider switched')).toBeNull();
    // A second click while the first request is in flight cannot enqueue another mutation.
    fireEvent.click(within(submenu).getByRole('option', { name: 'Proxy A' }));
    expect(requests()).toHaveLength(count + 1);
    reply({ ...data, supplierId: 'proxy-a', activeSupplierId: 'proxy-a' });
    expect(await screen.findByText('Provider switched')).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(vi.mocked(window.sendToJava!).mock.calls.some(([message]) => /^(switch_provider|switch_codex_provider):/.test(message))).toBe(false);
  });

  it('uses the session checkmark and ignores global default changes', async () => {
    render(<SessionMenu />);
    const submenu = await openSupplierMenu({ supplierId: 'b' });
    expect(within(submenu).getByRole('option', { selected: true }).textContent).toContain('Provider B');
    act(() => window.updateActiveProvider?.(JSON.stringify({ id: 'a', isActive: true })));
    expect(within(submenu).getByRole('option', { selected: true }).textContent).toContain('Provider B');
  });

  it('keeps failed selections visible without a success toast and refreshes on reopening', async () => {
    render(<SessionMenu />);
    const submenu = await openSupplierMenu();
    fireEvent.click(within(submenu).getByText('Provider B'));
    reply({ error: 'Supplier unavailable' });
    expect(within(submenu).getByRole('status').textContent).toContain('Supplier unavailable');
    expect(within(submenu).getByRole('option', { selected: true }).textContent).toContain('Provider A');
    expect(screen.queryByText('Provider switched')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Configure/i }));
    const count = requests().length;
    fireEvent.click(screen.getByRole('button', { name: /Configure/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch provider' }));
    expect(requests()).toHaveLength(count + 1);
    expect(requests().at(-1)).toMatch(/^get_session_suppliers:/);
    reply({ supplierId: 'b' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('Provider B');
  });

  it('keeps missing and disabled bindings explicit without selecting a fallback', async () => {
    render(<SessionMenu />);
    const submenu = await openSupplierMenu({ supplierId: 'deleted', suppliers: [
      { id: 'a', name: 'Provider A', available: true }, { id: 'disabled', name: 'Disabled', available: false },
    ] });
    expect(within(submenu).queryByRole('option', { selected: true })).toBeNull();
    expect(within(submenu).getByRole('status').textContent).toBe('Select a supplier');
    const count = requests().length;
    fireEvent.click(within(submenu).getByRole('option', { name: 'Disabled' }));
    expect(requests()).toHaveLength(count);
  });

  it('explains that a busy conversation applies the new supplier on its next turn', async () => {
    render(<SessionMenu busy />);
    const submenu = await openSupplierMenu({ busy: true });
    fireEvent.click(within(submenu).getByText('Provider B'));
    reply({ supplierId: 'b', activeSupplierId: 'a', busy: true });
    expect(await screen.findByText(/Provider switched.*Applies to the next turn/)).toBeTruthy();
  });

  it('discards a pending old conversation reply and sends the new binding fence', async () => {
    const view = render(<SessionMenu />);
    const submenu = await openSupplierMenu();
    fireEvent.click(within(submenu).getByText('Provider B'));
    const previous = lastRequest();
    session.currentSessionId = 'history-b';
    view.rerender(<SessionMenu />);
    await waitFor(() => expect(lastRequest().requestId).not.toBe(previous.requestId));
    reply({ supplierId: 'b', bindingToken: 'binding-b' });
    await act(async () => window.onSessionSuppliers?.(JSON.stringify({ ...previous, supplierId: 'a', bindingToken: 'binding-a' })));
    expect(screen.queryByText('Provider switched')).toBeNull();
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('Provider B');
    fireEvent.click(screen.getByRole('option', { name: 'Provider A' }));
    expect(lastRequest()).toMatchObject({ supplierId: 'a', sessionId: 'history-b', bindingToken: 'binding-b' });
  });

  it('opens the node process submenu in a narrow panel without entering a layout update loop', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 410,
    });
    getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getMockRect(this: HTMLElement) {
        if (this.classList.contains('node-process-dropdown')) {
          return this.style.right === '100%'
            ? rect(10, 360, 350)
            : rect(390, 740, 350);
        }
        if (this.classList.contains('selector-option') && this.textContent?.includes('Node processes')) {
          return rect(190, 390, 200);
        }
        return rect(0, 0, 0);
      });

    const { container } = render(<ConfigSelect currentProvider="claude" />);

    fireEvent.click(screen.getByRole('button', { name: /Configure/i }));
    fireEvent.mouseEnter(screen.getByText('Node processes').closest('.selector-option')!);

    const dropdown = container.querySelector<HTMLElement>('.node-process-dropdown');
    expect(dropdown).not.toBeNull();

    await waitFor(() => {
      expect(dropdown?.style.right).toBe('100%');
    });
  });
  it.each(['grok', 'kimi', 'opencode', 'pi', 'omp', 'dsh'])(
    'hides the runtime provider entry for the %s CLI',
    (provider) => {
      render(<ConfigSelect currentProvider={provider} />);

      fireEvent.click(screen.getByRole('button', { name: /Configure/i }));

      expect(screen.queryByText('Switch provider')).toBeNull();
      expect(screen.getByText('Node processes')).toBeTruthy();
    },
  );
});
