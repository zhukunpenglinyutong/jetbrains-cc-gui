import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ChangelogDialog from './ChangelogDialog';

const REPO_URL = 'https://github.com/zhukunpenglinyutong/jetbrains-cc-gui';
const openBrowserMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh' },
  }),
}));

vi.mock('../utils/bridge', () => ({
  GITHUB_REPO_URL: 'https://github.com/zhukunpenglinyutong/jetbrains-cc-gui',
  openBrowser: (...args: unknown[]) => openBrowserMock(...args),
}));

const entries = [
  {
    version: '0.5.4',
    date: '2026-08-26',
    content: {
      en: '- New feature',
      zh: '- 新功能',
    },
  },
];

describe('ChangelogDialog star banner', () => {
  beforeEach(() => {
    window.localStorage.clear();
    openBrowserMock.mockClear();
  });

  it('shows the banner and opens the repo when the star button is clicked', () => {
    render(<ChangelogDialog isOpen onClose={() => {}} entries={entries} />);

    expect(screen.getByText('chat.openSourceBanner')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'chat.openSourceBannerStarAria' }));
    expect(openBrowserMock).toHaveBeenCalledWith(REPO_URL);
  });
});
