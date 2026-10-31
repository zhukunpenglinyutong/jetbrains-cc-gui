import { act, fireEvent, render, screen } from '@testing-library/react';
import { StartupHistoryLoadBanner } from './StartupHistoryLoadBanner';
import type { StartupHistoryLoadState } from '../types/startupHistory';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const baseState: StartupHistoryLoadState = {
  status: 'unloaded',
  sessionId: 'session-1',
  requestId: '',
  generation: 0,
  messageCount: 0,
  retryable: true,
};

describe('StartupHistoryLoadBanner', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('loads an unloaded restored session and ignores another session', () => {
    const { rerender } = render(
      <StartupHistoryLoadBanner state={baseState} currentSessionId="session-1" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'startupHistory.load' }));
    expect(window.sendToJava).toHaveBeenCalledWith('load_restored_history:');

    rerender(<StartupHistoryLoadBanner state={baseState} currentSessionId="session-2" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('cancels only the active request id', () => {
    render(
      <StartupHistoryLoadBanner
        state={{ ...baseState, status: 'loading', requestId: 'request-7', retryable: false }}
        currentSessionId="session-1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'startupHistory.cancel' }));
    expect(window.sendToJava).toHaveBeenCalledWith('cancel_restored_history:request-7');
  });

  it('dismisses committed success and keeps a later retry visible', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<StartupHistoryLoadBanner
        state={{ ...baseState, status: 'loaded', generation: 1, retryable: false }} currentSessionId="session-1" />);
      expect(screen.getByRole('status')).not.toBeNull();
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.queryByRole('status')).toBeNull();
      rerender(<StartupHistoryLoadBanner state={{ ...baseState, status: 'failed', generation: 2 }} currentSessionId="session-1" />);
      expect(screen.getByRole('button', { name: 'startupHistory.retry' })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains retired history without offering an impossible retry on the new session', () => {
    vi.useFakeTimers();
    try {
      render(<StartupHistoryLoadBanner state={{ ...baseState, status: 'missing', retryable: false }} currentSessionId={null} />);
      expect(screen.getByRole('status').textContent).toContain('startupHistory.missing');
      expect(screen.queryByRole('button')).toBeNull();
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
