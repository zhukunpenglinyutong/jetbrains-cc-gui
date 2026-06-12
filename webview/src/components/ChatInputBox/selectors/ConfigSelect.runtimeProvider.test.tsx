import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSelect } from './ConfigSelect';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';

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
      'config.runtimeProvider.switched': 'Provider switched to Proxy A',
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

  it('switches Claude runtime providers from the configure menu', async () => {
    render(<ConfigSelect currentProvider="claude" />);

    fireEvent.click(screen.getByRole('button', { name: /Configure/i }));
    const providerMenuItem = screen.getByText('Switch provider').closest('.selector-option')!;
    expect(providerMenuItem.previousElementSibling?.className).toContain('selector-divider');
    expect(providerMenuItem.nextElementSibling?.className).toContain('selector-divider');
    fireEvent.mouseEnter(providerMenuItem);

    expect(window.sendToJava).toHaveBeenCalledWith('get_providers:');

    act(() => {
      window.updateProviders?.(JSON.stringify([
        { id: SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS, name: 'hidden local', isActive: true },
        { id: SPECIAL_PROVIDER_IDS.CLI_LOGIN, name: 'hidden cli', isActive: false },
        { id: 'proxy-a', name: 'Proxy A', remark: 'fast route', isActive: false },
      ]));
    });

    const submenu = await screen.findByRole('listbox');
    expect(within(submenu).getByText('Use local settings.json')).toBeTruthy();
    expect(within(submenu).getByText('Use CLI login')).toBeTruthy();
    expect(within(submenu).getByText('Proxy A')).toBeTruthy();

    fireEvent.click(within(submenu).getByText('Proxy A'));

    expect(window.sendToJava).toHaveBeenCalledWith('switch_provider:{"id":"proxy-a"}');
    expect(await screen.findByText('Provider switched to Proxy A')).toBeTruthy();
  });

  it('switches Codex runtime providers from the configure menu', async () => {
    render(<ConfigSelect currentProvider="codex" />);

    fireEvent.click(screen.getByRole('button', { name: /Configure/i }));
    fireEvent.mouseEnter(screen.getByText('Switch provider').closest('.selector-option')!);

    expect(window.sendToJava).toHaveBeenCalledWith('get_codex_providers:');

    act(() => {
      window.updateCodexProviders?.(JSON.stringify([
        { id: SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN, name: 'hidden codex local', isActive: true },
        { id: 'codex-proxy', name: 'Codex Proxy', remark: 'workspace config', isActive: false },
      ]));
    });

    const submenu = await screen.findByRole('listbox');
    expect(within(submenu).getByText('Use local Codex config')).toBeTruthy();
    expect(within(submenu).getByText('Codex Proxy')).toBeTruthy();

    fireEvent.click(within(submenu).getByText('Codex Proxy'));

    expect(window.sendToJava).toHaveBeenCalledWith('switch_codex_provider:{"id":"codex-proxy"}');
  });

  it('refreshes selected provider when backend confirms active provider change', async () => {
    render(<ConfigSelect currentProvider="claude" />);

    fireEvent.click(screen.getByRole('button', { name: /Configure/i }));
    fireEvent.mouseEnter(screen.getByText('Switch provider').closest('.selector-option')!);

    act(() => {
      window.updateProviders?.(JSON.stringify([
        { id: 'a', name: 'Provider A', isActive: true },
        { id: 'b', name: 'Provider B', isActive: false },
      ]));
    });

    const submenu = await screen.findByRole('listbox');

    act(() => {
      window.updateActiveProvider?.(JSON.stringify({ id: 'b', name: 'Provider B', isActive: true }));
    });

    await waitFor(() => {
      expect(within(submenu).getByText('Provider B').closest('.selector-option')?.className).toContain('selected');
    });
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
});
