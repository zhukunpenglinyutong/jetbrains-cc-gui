// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderSelect } from './ProviderSelect';

vi.mock('../../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      const map: Record<string, string> = {
        'providers.claude.label': 'Claude Code',
        'providers.manageCli': 'CLI Settings',
        'config.switchProvider': 'Switch provider',
      };
      const defaultValue = options && typeof options === 'object' && 'defaultValue' in options
        ? String((options as Record<string, unknown>).defaultValue)
        : '';
      return map[key] ?? (defaultValue || key);
    },
  }),
}));

describe('ProviderSelect CLI settings footer', () => {
  it('renders the footer only when onOpenCliSettings is provided', () => {
    const { unmount } = render(<ProviderSelect value="claude" />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.querySelector('.provider-cli-footer-btn')).toBeNull();
    unmount();

    render(<ProviderSelect value="claude" onOpenCliSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.querySelector('.provider-cli-footer-btn')).toBeTruthy();
    expect(screen.getByText('CLI Settings')).toBeTruthy();
  });

  it('invokes onOpenCliSettings and closes the dropdown on click', () => {
    const onOpenCliSettings = vi.fn();
    render(<ProviderSelect value="claude" onOpenCliSettings={onOpenCliSettings} />);
    fireEvent.click(screen.getByRole('button'));

    fireEvent.click(screen.getByText('CLI Settings'));

    expect(onOpenCliSettings).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.selector-dropdown')).toBeNull();
  });
});
