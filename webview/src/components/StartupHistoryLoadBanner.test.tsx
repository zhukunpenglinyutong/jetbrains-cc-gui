import { fireEvent, render, screen } from '@testing-library/react';
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
});
