import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openBrowser } from '../../../utils/bridge';
import DshConnectionCard from './DshConnectionCard';

const translations: Record<string, string> = {
  'settings.cli.dsh.groupTitle': 'DeepSeek Harness',
  'settings.cli.dsh.cardTitle': 'Local host',
  'settings.cli.dsh.rowHint': 'Start or adopt the local dsh web host',
  'settings.cli.dsh.hint': 'Persistent local host',
  'settings.cli.dsh.state.checking': 'Checking…',
  'settings.cli.dsh.state.notInstalled': 'Not installed',
  'settings.cli.dsh.state.notRunning': 'Not running',
  'settings.cli.dsh.state.connected': 'Connected',
  'settings.cli.dsh.adopted': 'adopted',
  'settings.cli.dsh.adoptedHint': 'Adopted an already-running host',
  'settings.cli.dsh.openWebUi': 'Open DSH Web UI',
  'settings.cli.dsh.startHost': 'Start host',
  'settings.cli.dsh.stopHost': 'Stop host (plugin-spawned only)',
  'settings.cli.dsh.autoStart': 'Auto-start when needed',
  'settings.cli.dsh.moreActions': 'More',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

vi.mock('../../../utils/bridge', () => ({
  openBrowser: vi.fn(),
}));

const connectedPayload = {
  success: true,
  installed: true,
  version: '0.1.1',
  origin: 'http://127.0.0.1:8787',
  hostRunning: true,
  ownership: 'spawned' as const,
  describe: { provider: 'deepseek', model: 'v3' },
  settings: { autoStart: true },
};

describe('DshConnectionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sendToJava = vi.fn();
    window.updateDshStatus = undefined;
  });

  afterEach(() => {
    window.sendToJava = undefined;
    window.updateDshStatus = undefined;
  });

  const pushStatus = (payload: Record<string, unknown>) => {
    act(() => {
      window.updateDshStatus?.(JSON.stringify(payload));
    });
  };

  it('requests host status on mount', () => {
    render(<DshConnectionCard nested />);
    expect(window.sendToJava).toHaveBeenCalledWith('get_dsh_status');
  });

  it('uses the nested card class so the host row matches the CLI row inset', () => {
    render(<DshConnectionCard nested />);
    expect(screen.getByTestId('dsh-host-card').className).toMatch(/nestedCard/);
  });

  it('keeps globe, stop, and auto-start inside the more menu while connected', () => {
    render(<DshConnectionCard nested />);
    pushStatus(connectedPayload);

    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.queryByText('Open DSH Web UI')).toBeNull();
    expect(screen.queryByText('Stop host (plugin-spawned only)')).toBeNull();
    expect(screen.queryByText('Auto-start when needed')).toBeNull();
    expect(screen.queryByLabelText('Open DSH Web UI')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByTestId('dsh-more-menu')).toBeTruthy();
    expect(screen.getByText('Open DSH Web UI')).toBeTruthy();
    expect(screen.getByText('Stop host (plugin-spawned only)')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Auto-start when needed' })).toBeTruthy();
  });

  it('opens the web UI and stops a spawned host from the more menu', () => {
    render(<DshConnectionCard nested />);
    pushStatus(connectedPayload);

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open DSH Web UI' }));
    expect(openBrowser).toHaveBeenCalledWith('http://127.0.0.1:8787');
    expect(screen.queryByTestId('dsh-more-menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop host (plugin-spawned only)' }));
    expect(window.sendToJava).toHaveBeenCalledWith('stop_dsh_host');
  });

  it('toggles auto-start from the more menu without closing it', () => {
    render(<DshConnectionCard nested />);
    pushStatus({ ...connectedPayload, settings: { autoStart: true } });

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const checkbox = screen.getByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    fireEvent.click(checkbox);
    expect(window.sendToJava).toHaveBeenCalledWith('save_dsh_settings:{"autoStart":false}');
    expect(screen.getByTestId('dsh-more-menu')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('keeps start host as a primary action when the host is not running', () => {
    render(<DshConnectionCard nested />);
    pushStatus({
      success: true,
      installed: true,
      hostRunning: false,
      settings: { autoStart: false },
    });

    expect(screen.getByText('Start host')).toBeTruthy();
    expect(screen.queryByText('Open DSH Web UI')).toBeNull();
    expect(screen.queryByText('Stop host (plugin-spawned only)')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText('Auto-start when needed')).toBeTruthy();
    expect(screen.queryByText('Open DSH Web UI')).toBeNull();
  });

  it('closes the more menu on outside click and Escape', () => {
    render(<DshConnectionCard nested />);
    pushStatus(connectedPayload);

    const moreButton = screen.getByRole('button', { name: 'More' });
    fireEvent.click(moreButton);
    expect(screen.getByTestId('dsh-more-menu')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('dsh-more-menu')).toBeNull();

    fireEvent.click(moreButton);
    expect(screen.getByTestId('dsh-more-menu')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('dsh-more-menu')).toBeNull();
    expect(document.activeElement).toBe(moreButton);
  });

  it('hides stop when the plugin only adopted an existing host', () => {
    render(<DshConnectionCard nested />);
    pushStatus({ ...connectedPayload, ownership: 'adopted' });

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText('Open DSH Web UI')).toBeTruthy();
    expect(screen.queryByText('Stop host (plugin-spawned only)')).toBeNull();
  });
});
