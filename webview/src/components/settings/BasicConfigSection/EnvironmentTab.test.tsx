import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import EnvironmentTab from './EnvironmentTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function renderEnvironmentTab(overrides: Partial<ComponentProps<typeof EnvironmentTab>> = {}) {
  const props: ComponentProps<typeof EnvironmentTab> = {
    nodePath: '/usr/bin/node',
    onNodePathChange: vi.fn(),
    onSaveNodePath: vi.fn(),
    savingNodePath: false,
    ...overrides,
  };
  return { props, ...render(<EnvironmentTab {...props} />) };
}

function stateLabel(): string {
  return screen.getByTestId('env-file-state').textContent ?? '';
}

describe('EnvironmentTab env file state', () => {
  it('shows the neutral unknown state when the backend has not answered yet', () => {
    renderEnvironmentTab();

    expect(screen.getByTestId('env-file-state').getAttribute('data-state')).toBe('unknown');
    expect(stateLabel()).toContain('settings.basic.envFile.state.unknown');
  });

  it('describes auto-discovery when nothing is configured', () => {
    renderEnvironmentTab({ envFileState: 'notConfigured', envFile: '.env' });

    expect(screen.getByTestId('env-file-state').getAttribute('data-state')).toBe('notConfigured');
    expect(stateLabel()).toContain('settings.basic.envFile.state.notConfiguredDetail');
  });

  it('describes a custom path when one is configured', () => {
    renderEnvironmentTab({ envFileState: 'configured', envFile: '/projects/app/.env.local' });

    expect(screen.getByTestId('env-file-state').getAttribute('data-state')).toBe('configured');
    expect(stateLabel()).toContain('settings.basic.envFile.state.configuredDetail');
  });

  it('makes an explicit opt-out visible instead of looking like an empty field', () => {
    renderEnvironmentTab({ envFileState: 'disabled', envFile: '' });

    expect(screen.getByTestId('env-file-state').getAttribute('data-state')).toBe('disabled');
    expect(stateLabel()).toContain('settings.basic.envFile.state.disabled');
    expect(stateLabel()).toContain('settings.basic.envFile.state.disabledDetail');
  });

  it('renders the reset control that reaches the third state', () => {
    const onResetEnvFile = vi.fn();
    renderEnvironmentTab({ envFileState: 'disabled', onResetEnvFile });

    fireEvent.click(screen.getByRole('button', { name: /settings\.basic\.envFile\.reset/ }));

    expect(onResetEnvFile).toHaveBeenCalledTimes(1);
  });

  it('disables the reset control while a save is in flight', () => {
    renderEnvironmentTab({ savingEnvFile: true });

    const resetButton = screen.getByRole('button', { name: /settings\.basic\.envFile\.reset/ });
    expect((resetButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the client-side validation reason', () => {
    renderEnvironmentTab({ envFileError: 'parentTraversal' });

    expect(screen.getByText('settings.basic.envFile.error.parentTraversal')).toBeTruthy();
  });
});
