import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { HistoryData } from '../types';
import { AppHeader } from './AppHeader';

// AppHeader wires context state into ChatHeader; the tests below only pin the
// regenerate-button visibility rules, so the contexts are mocked rather than
// mounted and the rest of the header is taken at face value.

let sessionState: {
  currentSessionId: string | null;
  historyData: HistoryData | null;
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({ 'history.regenerateTitle': 'Regenerate title from conversation' }[key] ?? key),
  }),
}));

vi.mock('../contexts/SessionContext', () => ({
  useSession: () => ({
    currentSessionId: sessionState.currentSessionId,
    historyData: sessionState.historyData,
    setCustomSessionTitle: vi.fn(),
  }),
}));

vi.mock('../contexts/UIStateContext', () => ({
  useUIState: () => ({
    currentView: 'chat',
    setCurrentView: vi.fn(),
    setSettingsInitialTab: vi.fn(),
    setSettingsProviderSubTab: vi.fn(),
    setSearchOpen: vi.fn(),
  }),
}));

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

beforeEach(() => {
  sessionState = {
    currentSessionId: 'session-one',
    historyData: {
      success: true,
      sessions: [{ sessionId: 'session-one', title: 'AI-generated title' }],
    },
  };
});

const actions = {
  sessionTitle: 'Session title',
  onNewSession: vi.fn(),
  onUpdateHistoryTitle: vi.fn(),
  onRegenerateTitle: vi.fn(),
  regeneratingTitleSessionIds: new Set<string>(),
  canRegenerateTitle: true,
};

describe('AppHeader regenerate-title button visibility', () => {
  it('renders the refresh button for a Claude session without a manual title', () => {
    render(<AppHeader {...actions} />);
    expect(screen.getByRole('button', { name: 'Regenerate title from conversation' })).toBeTruthy();
  });

  // A manual title wins over the AI title (customTitle > aiTitle), so the
  // regeneration could never stick — the button stays hidden instead of
  // reporting a success the UI would immediately override.
  it('hides the refresh button when the current session has a manual title', () => {
    sessionState.historyData = {
      success: true,
      sessions: [{ sessionId: 'session-one', title: 'Renamed by hand', hasCustomTitle: true }],
    };
    render(<AppHeader {...actions} />);
    expect(screen.queryByRole('button', { name: 'Regenerate title from conversation' })).toBeNull();
  });

  // Regression: loading a history session seeds customSessionTitle with the
  // displayed title (AI titles included), so manual-title detection must come
  // from the history snapshot's hasCustomTitle flag — never from the mere
  // presence of a displayed title.
  it('keeps the refresh button after switching to a session whose title is AI-generated', () => {
    render(<AppHeader {...actions} />);
    expect(screen.getByRole('button', { name: 'Regenerate title from conversation' })).toBeTruthy();
  });

  it('keeps the refresh button when the session is not in the history snapshot (e.g. a fresh session)', () => {
    sessionState.historyData = null;
    render(<AppHeader {...actions} />);
    expect(screen.getByRole('button', { name: 'Regenerate title from conversation' })).toBeTruthy();
  });

  it('hides the refresh button without an active session id or on non-Claude providers', () => {
    sessionState.currentSessionId = null;
    const { rerender } = render(<AppHeader {...actions} />);
    expect(screen.queryByRole('button', { name: 'Regenerate title from conversation' })).toBeNull();

    sessionState.currentSessionId = 'session-one';
    rerender(<AppHeader {...actions} canRegenerateTitle={false} />);
    expect(screen.queryByRole('button', { name: 'Regenerate title from conversation' })).toBeNull();
  });
});
