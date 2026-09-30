import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryData } from '../types';
import { SessionProvider, useSession } from '../contexts/SessionContext';
import { UIStateProvider } from '../contexts/UIStateContext';
import { AppHeader } from './AppHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'history.convertActiveHint': 'Convert to CLI after ending the session',
        'history.convertActiveHintTooltip': 'End or close this session first, then convert it from the history list',
      };
      return translations[key] ?? (options?.defaultValue as string) ?? key;
    },
  }),
}));

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

const { sendBridgeEvent } = await import('../utils/bridge');

/** Seeds SessionContext with the active session and the history snapshot. */
const Harness = ({
  sessionId,
  historyData,
}: {
  sessionId: string | null;
  historyData: HistoryData | null;
}) => {
  const { setCurrentSessionId, setHistoryData } = useSession();
  React.useEffect(() => {
    setCurrentSessionId(sessionId);
    setHistoryData(historyData);
  }, [sessionId, historyData, setCurrentSessionId, setHistoryData]);
  // Mirrors messageCallbacks: the backend pushes the loaded history here.
  // Registered outside the seeding effect so it survives re-seeds.
  React.useEffect(() => {
    window.setHistoryData = data => setHistoryData(data);
    return () => { delete window.setHistoryData; };
  }, [setHistoryData]);
  return null;
};

const renderHeader = (sessionId: string | null, historyData: HistoryData | null) =>
  render(
    <SessionProvider>
      <UIStateProvider>
        <Harness sessionId={sessionId} historyData={historyData} />
        <AppHeader
          sessionTitle="Test session"
          onNewSession={vi.fn()}
          onUpdateHistoryTitle={vi.fn()}
        />
      </UIStateProvider>
    </SessionProvider>
  );

const historyWith = (entrypoint?: string): HistoryData => ({
  success: true,
  sessions: [
    {
      sessionId: 'active-session',
      title: 'Test session',
      messageCount: 1,
      ...(entrypoint !== undefined ? { entrypoint } : {}),
    },
  ],
});

describe('AppHeader convert hint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The bootstrap waits for the bridge before sending; without this it would
    // poll a bridge that never appears.
    window.sendToJava = vi.fn();
  });

  it('shows the hint when the active session is convertible', async () => {
    renderHeader('active-session', historyWith('sdk-cli'));

    expect(await screen.findByText('Convert to CLI after ending the session')).toBeTruthy();
  });

  it('shows the hint for claude-vscode sessions too', async () => {
    renderHeader('active-session', historyWith('claude-vscode'));

    expect(await screen.findByText('Convert to CLI after ending the session')).toBeTruthy();
  });

  it('omits the hint for a CLI session', async () => {
    renderHeader('active-session', historyWith('cli'));

    expect(await screen.findByText('Test session')).toBeTruthy();
    expect(screen.queryByText('Convert to CLI after ending the session')).toBeNull();
  });

  it('omits the hint for an unrecognized entrypoint', async () => {
    renderHeader('active-session', historyWith('some-future-entrypoint'));

    expect(await screen.findByText('Test session')).toBeTruthy();
    expect(screen.queryByText('Convert to CLI after ending the session')).toBeNull();
  });

  it('omits the hint when the session has no entrypoint data', async () => {
    renderHeader('active-session', historyWith(undefined));

    expect(await screen.findByText('Test session')).toBeTruthy();
    expect(screen.queryByText('Convert to CLI after ending the session')).toBeNull();
  });

  it('omits the hint when the session is not in the history snapshot', async () => {
    renderHeader('unknown-session', historyWith('sdk-cli'));

    expect(await screen.findByText('Test session')).toBeTruthy();
    expect(screen.queryByText('Convert to CLI after ending the session')).toBeNull();
  });

  it('omits the hint when there is no active session', async () => {
    renderHeader(null, historyWith('sdk-cli'));

    expect(await screen.findByText('Test session')).toBeTruthy();
    expect(screen.queryByText('Convert to CLI after ending the session')).toBeNull();
  });

  it('never renders a convert button — the active session cannot be converted', async () => {
    renderHeader('active-session', historyWith('sdk-cli'));

    await screen.findByText('Convert to CLI after ending the session');
    expect(screen.queryByRole('button', { name: /convert/i })).toBeNull();
  });

  // Acceptance for the bootstrap: a fresh tool window has no history snapshot at
  // all, yet the hint — whose whole audience is the session the SDK just
  // created — must still render.
  it('renders the hint on a fresh window with no prior history visit', async () => {
    renderHeader('active-session', null);

    expect(screen.queryByText('Convert to CLI after ending the session')).toBeNull();

    await waitFor(() => {
      expect(sendBridgeEvent).toHaveBeenCalledWith('load_history_data', 'claude');
    });

    // The backend answers the bootstrap request through window.setHistoryData,
    // the same channel the history view's own load uses.
    act(() => {
      window.setHistoryData?.(historyWith('sdk-cli'));
    });

    expect(await screen.findByText('Convert to CLI after ending the session')).toBeTruthy();
  });
});
