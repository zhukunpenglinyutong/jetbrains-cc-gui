// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderSelect } from './ProviderSelect';
import {
  CLI_PROVIDER_VISIBILITY_KEY,
  setCliProviderHidden,
} from '../../../utils/cliProviderVisibility';

vi.mock('../../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      const map: Record<string, string> = {
        'providers.claude.label': 'Claude Code',
        'providers.codex.label': 'Codex',
        'providers.grok.label': 'Grok CLI',
        'providers.kimi.label': 'Kimi CLI',
        'config.switchProvider': 'Switch provider',
      };
      const defaultValue = options && typeof options === 'object' && 'defaultValue' in options
        ? String((options as Record<string, unknown>).defaultValue)
        : '';
      return map[key] ?? (defaultValue || key);
    },
  }),
}));

describe('ProviderSelect CLI visibility', () => {
  afterEach(() => {
    localStorage.removeItem(CLI_PROVIDER_VISIBILITY_KEY);
  });

  const openMenu = () => {
    fireEvent.click(screen.getByRole('button'));
    return within(document.querySelector('.provider-dropdown') as HTMLElement);
  };

  it('omits hidden CLI providers from the switcher menu', () => {
    setCliProviderHidden('grok', true);

    render(<ProviderSelect value="claude" />);
    const menu = openMenu();

    expect(menu.queryByText('Grok CLI')).toBeNull();
    expect(menu.getByText('Kimi CLI')).toBeTruthy();
    expect(menu.getByText('Claude Code')).toBeTruthy();
  });

  it('reacts to visibility changes made while mounted', () => {
    render(<ProviderSelect value="claude" />);
    const menu = openMenu();
    expect(menu.getByText('Grok CLI')).toBeTruthy();
    act(() => {
      setCliProviderHidden('grok', true);
    });

    expect(menu.queryByText('Grok CLI')).toBeNull();
  });

  it('keeps a hidden provider functional when it is the active selection', () => {
    setCliProviderHidden('grok', true);

    render(<ProviderSelect value="grok" />);

    // Trigger button still displays the active hidden provider.
    expect(screen.getByRole('button').textContent).toContain('Grok CLI');
  });
});
