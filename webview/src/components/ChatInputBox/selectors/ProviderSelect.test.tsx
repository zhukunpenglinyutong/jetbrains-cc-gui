// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSelect } from './ProviderSelect';

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
        'providers.minimax.label': 'MiniMax Code',
        'providers.zcode.label': 'ZCode',
        'providers.opencode.label': 'OpenCode',
        'providers.pi.label': 'PI CLI',
        'providers.omp.label': 'OMP CLI',
        'providers.dsh.label': 'DeepSeek Harness',
        'settings.provider.featureComingSoon': 'Coming soon',
        'config.switchProvider': 'Switch provider',
      };
      const defaultValue = options && typeof options === 'object' && 'defaultValue' in options
        ? String((options as Record<string, unknown>).defaultValue)
        : '';
      return map[key] ?? (defaultValue || key);
    },
  }),
}));

describe('ProviderSelect', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    window.updateCodexSubscriptionQuota = undefined;
  });

  it('applies every CLI provider immediately without a dialog', () => {
    for (const [label, id] of [
      ['Grok CLI', 'grok'],
      ['Kimi CLI', 'kimi'],
      ['OpenCode', 'opencode'],
      ['PI CLI', 'pi'],
      ['OMP CLI', 'omp'],
      ['DeepSeek Harness', 'dsh'],
      ['MiniMax Code', 'minimax'],
      ['ZCode', 'zcode'],
    ] as const) {
      const onChange = vi.fn();
      const { unmount } = render(<ProviderSelect value="claude" onChange={onChange} />);

      fireEvent.click(screen.getByRole('button'));
      fireEvent.click(screen.getByText(label));

      expect(onChange).toHaveBeenCalledWith(id);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.querySelector('.confirm-dialog-overlay')).toBeNull();
      expect(document.querySelector('.provider-dropdown')).toBeNull();
      unmount();
    }
  });

  it('renders no beta badge on any provider row', () => {
    render(<ProviderSelect value="claude" />);
    fireEvent.click(screen.getByRole('button'));

    expect(document.querySelector('.provider-beta-badge')).toBeNull();
    expect(screen.queryByText('Beta')).toBeNull();
  });
});
