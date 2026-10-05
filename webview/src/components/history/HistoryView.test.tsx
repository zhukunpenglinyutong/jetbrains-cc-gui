import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryData, HistorySessionSummary } from '../../types';
import { sendBridgeEvent } from '../../utils/bridge';
import HistoryView, { BATCH_CONVERSION_TIMEOUT_MS } from './HistoryView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'history.totalSessions': `${options?.count} sessions · ${options?.total} messages`,
        'history.messageCount': `${options?.count} messages`,
        'history.selectMode': 'Select',
        'history.exitSelectMode': 'Exit selection',
        'history.selectedSessions': `${options?.count} selected`,
        'history.selectAll': 'Select all',
        'history.clearSelection': 'Clear',
        'history.deleteSelected': 'Delete selected',
        'history.confirmDeleteSelected': 'Confirm Delete',
        'history.deleteSelectedMessage': `Delete ${options?.count} selected sessions?`,
        'history.selectSession': 'Select session',
        'history.selectSessionWithTitle': `Select ${String(options?.title ?? '')}`,
        'history.searchPlaceholder': 'Search session titles...',
        'history.deepSearchTooltip': 'Deep Search',
        'history.favoriteSession': 'Favorite session',
        'history.unfavoriteSession': 'Unfavorite session',
        'history.convertToCliSession': 'Convert to CLI session',
        'history.convertButton': 'Convert',
        'history.confirmConvert': 'Convert to CLI?',
        'history.convertConfirmMessage': 'This changes the entrypoint.',
        'history.convertAllToCliSessionsTooltip': `Convert ${options?.count} SDK sessions`,
        'history.convertFailed': 'Conversion failed',
        'history.convertAllSuccess': `${options?.count} session(s) converted`,
        'history.convertAllPartial': `Converted ${options?.count} of ${options?.total}, ${options?.failed} failed`,
        'history.convertAllAlreadyRunning': 'A conversion is already running',
        'history.convertAllTimeout': 'The conversion took too long',
        'history.convertAllBridgeUnavailable': 'The conversion could not be started: the plugin is not responding. Try again in a moment.',
        'history.convertAllToCliSessionsLabel': 'Convert all to CLI',
        'history.convertAllToCliSessionsEmptyTooltip': 'No SDK or VS Code sessions to convert.',
        'common.cancel': 'Cancel',
        'common.delete': 'Delete',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('../../utils/bridge', () => ({
  // The real helper only returns false when window.sendToJava is missing, so the default
  // has to model a live bridge; a test that wants a dead one opts in per call.
  sendBridgeEvent: vi.fn(() => true),
}));

vi.mock('../../utils/copyUtils', () => ({
  copyToClipboard: vi.fn(async () => true),
}));

const historyData: HistoryData = {
  success: true,
  total: 10,
  sessions: [
    {
      sessionId: 'session-one',
      title: 'First session',
      messageCount: 4,
      lastTimestamp: new Date().toISOString(),
      provider: 'claude',
    },
    {
      sessionId: 'session-two',
      title: 'Second session',
      messageCount: 6,
      lastTimestamp: new Date().toISOString(),
      provider: 'codex',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HistoryView multi-select', () => {
  it('deletes selected sessions after confirmation without loading them', () => {
    const onLoadSession = vi.fn();
    const onDeleteSession = vi.fn();
    const onDeleteSessions = vi.fn();

    render(
      <HistoryView
        historyData={historyData}
        currentProvider="claude"
        onLoadSession={onLoadSession}
        onDeleteSession={onDeleteSession}
        onDeleteSessions={onDeleteSessions}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select First session' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Second session' }));

    expect(screen.getByText('2 selected')).toBeTruthy();
    expect(onLoadSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete 2 selected sessions?')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(onDeleteSession).not.toHaveBeenCalled();
    expect(onDeleteSessions).toHaveBeenCalledTimes(1);
    expect(onDeleteSessions).toHaveBeenCalledWith(['session-one', 'session-two']);
    expect(onLoadSession).not.toHaveBeenCalled();
  });
});

describe('HistoryView conversion', () => {
  it('confirms SDK session conversion without loading the row', () => {
    const onLoadSession = vi.fn();
    const onConvertToCliSession = vi.fn();

    render(
      <HistoryView
        historyData={{
          ...historyData,
          sessions: [
            {
              ...historyData.sessions![0],
              entrypoint: 'sdk-cli',
            },
          ],
        }}
        currentProvider="claude"
        onLoadSession={onLoadSession}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={onConvertToCliSession}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Convert to CLI session' }));

    const dialog = screen.getByRole('dialog', { name: 'Convert to CLI?' });
    expect(within(dialog).getByText('This changes the entrypoint.')).toBeTruthy();
    expect(onLoadSession).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert' }));

    expect(onConvertToCliSession).toHaveBeenCalledTimes(1);
    expect(onConvertToCliSession).toHaveBeenCalledWith('session-one');
    expect(onLoadSession).not.toHaveBeenCalled();
  });

  it('hides the convert button for the currently active session', () => {
    render(
      <HistoryView
        historyData={{
          ...historyData,
          sessions: [
            {
              ...historyData.sessions![0],
              entrypoint: 'sdk-cli',
            },
          ],
        }}
        currentProvider="claude"
        currentSessionId="session-one"
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Convert to CLI session' })).toBeNull();
  });

  it('does not offer conversion for unknown entrypoints the backend cannot rewrite', () => {
    render(
      <HistoryView
        historyData={{
          ...historyData,
          sessions: [
            {
              ...historyData.sessions![0],
              entrypoint: 'some-future-entrypoint',
            },
          ],
        }}
        currentProvider="claude"
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Convert to CLI session' })).toBeNull();
  });

  it('clears deep search state when existing history data refreshes', () => {
    const { rerender } = render(
      <HistoryView
        historyData={historyData}
        currentProvider="claude"
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={vi.fn()}
      />,
    );

    const deepSearchButton = screen.getByRole('button', { name: 'Deep Search' });
    fireEvent.click(deepSearchButton);

    expect(sendBridgeEvent).toHaveBeenCalledWith('deep_search_history', 'claude');
    expect(deepSearchButton).toHaveProperty('disabled', true);

    rerender(
      <HistoryView
        historyData={{
          ...historyData,
          total: 11,
        }}
        currentProvider="claude"
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Deep Search' })).toHaveProperty('disabled', false);
  });
});

describe('HistoryView batch conversion', () => {
  const ACTIVE_SESSION_ID = 'active-session';

  const convertibleSession = (index: number): HistorySessionSummary => ({
    sessionId: `sdk-session-${index}`,
    title: `SDK session ${index}`,
    messageCount: 1,
    lastTimestamp: new Date().toISOString(),
    provider: 'claude',
    entrypoint: index % 2 === 0 ? 'sdk-cli' : 'claude-vscode',
  });

  // 50 convertible sessions plus the active one, which is never part of the batch.
  const batchHistoryData: HistoryData = {
    success: true,
    total: 51,
    sessions: [
      ...Array.from({ length: 50 }, (_, index) => convertibleSession(index)),
      {
        sessionId: ACTIVE_SESSION_ID,
        title: 'Active session',
        messageCount: 1,
        lastTimestamp: new Date().toISOString(),
        provider: 'claude',
        entrypoint: 'sdk-cli',
      },
    ],
  };

  const renderBatchView = (onConvertToCliSession = vi.fn(), currentProvider = 'claude') =>
    render(
      <HistoryView
        historyData={batchHistoryData}
        currentProvider={currentProvider}
        currentSessionId={ACTIVE_SESSION_ID}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={onConvertToCliSession}
      />,
    );

  const convertAllButton = () =>
    screen.getByRole('button', { name: /convert 50 sdk sessions/i }) as HTMLButtonElement;

  const answerBatch = (payload: Record<string, unknown>) => {
    act(() => {
      window.onBatchConversionResult?.(JSON.stringify(payload));
    });
  };

  const batchCalls = () =>
    (sendBridgeEvent as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([event]) => event === 'convert_all_to_cli_sessions');

  beforeEach(() => {
    window.addToast = vi.fn();
  });

  afterEach(() => {
    window.addToast = undefined;
    window.onBatchConversionResult = undefined;
  });

  it('sends one batch command for the whole set instead of one message per session', () => {
    const onConvertToCliSession = vi.fn();
    renderBatchView(onConvertToCliSession);

    fireEvent.click(convertAllButton());

    expect(sendBridgeEvent).toHaveBeenCalledWith('convert_all_to_cli_sessions');
    expect(batchCalls()).toHaveLength(1);
    expect(onConvertToCliSession).not.toHaveBeenCalled();
  });

  it('disables the button and ignores repeat clicks while a batch is in flight', () => {
    renderBatchView();

    fireEvent.click(convertAllButton());
    expect(convertAllButton()).toHaveProperty('disabled', true);

    fireEvent.click(convertAllButton());
    expect(batchCalls()).toHaveLength(1);

    answerBatch({ status: 'completed', total: 50, converted: 50, skipped: 0, failed: 0 });

    // The guard is released by the answer, otherwise the button would stay dead forever.
    expect(convertAllButton()).toHaveProperty('disabled', false);

    fireEvent.click(convertAllButton());
    expect(batchCalls()).toHaveLength(2);
  });

  it('reports one success toast and reloads history when everything converts', () => {
    renderBatchView();

    fireEvent.click(convertAllButton());
    answerBatch({ status: 'completed', total: 50, converted: 50, skipped: 0, failed: 0 });

    expect(window.addToast).toHaveBeenCalledTimes(1);
    expect(window.addToast).toHaveBeenCalledWith('50 session(s) converted', 'success');
    expect(sendBridgeEvent).toHaveBeenCalledWith('deep_search_history', 'claude');
  });

  it('reports a single combined toast when some sessions fail', () => {
    renderBatchView();

    fireEvent.click(convertAllButton());
    answerBatch({ status: 'completed', total: 50, converted: 48, skipped: 1, failed: 1 });

    expect(window.addToast).toHaveBeenCalledTimes(1);
    expect(window.addToast).toHaveBeenCalledWith('Converted 48 of 50, 1 failed', 'warning');
  });

  it('shows an informational toast when a batch is already running', () => {
    renderBatchView();

    fireEvent.click(convertAllButton());
    answerBatch({ status: 'already_running', total: 0, converted: 0, skipped: 0, failed: 0 });

    expect(window.addToast).toHaveBeenCalledTimes(1);
    expect(window.addToast).toHaveBeenCalledWith('A conversion is already running', 'info');
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('deep_search_history', 'claude');
  });

  it('surfaces the backend error text when the batch cannot run', () => {
    renderBatchView();

    fireEvent.click(convertAllButton());
    answerBatch({ status: 'failed', total: 0, converted: 0, skipped: 0, failed: 0, error: 'index unreadable' });

    expect(window.addToast).toHaveBeenCalledTimes(1);
    expect(window.addToast).toHaveBeenCalledWith('index unreadable', 'error');
    expect(convertAllButton()).toHaveProperty('disabled', false);
  });

  it('falls back to the generic failure toast when the payload is unparseable', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderBatchView();

    fireEvent.click(convertAllButton());
    act(() => {
      window.onBatchConversionResult?.('not json');
    });

    expect(window.addToast).toHaveBeenCalledTimes(1);
    expect(window.addToast).toHaveBeenCalledWith('Conversion failed', 'error');
    expect(convertAllButton()).toHaveProperty('disabled', false);
    consoleError.mockRestore();
  });

  it('clears the callback on unmount so a late answer cannot touch a dead view', () => {
    const { unmount } = renderBatchView();

    expect(window.onBatchConversionResult).toBeTypeOf('function');
    unmount();
    expect(window.onBatchConversionResult).toBeUndefined();
  });

  it('keeps one answer callback across re-renders so a provider switch cannot strand the batch', () => {
    const { rerender } = renderBatchView();
    const registeredBeforeSwitch = window.onBatchConversionResult;

    fireEvent.click(convertAllButton());

    rerender(
      <HistoryView
        historyData={batchHistoryData}
        currentProvider="codex"
        currentSessionId={ACTIVE_SESSION_ID}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={vi.fn()}
      />,
    );

    // The handler must be the very same function, never unregistered and replaced:
    // the old cleanup set window.onBatchConversionResult to undefined, so an answer
    // arriving during a language or provider switch went nowhere and left the guard
    // stuck at true — the button stayed disabled until the window was reloaded.
    expect(window.onBatchConversionResult).toBe(registeredBeforeSwitch);

    answerBatch({ status: 'completed', total: 50, converted: 50, skipped: 0, failed: 0 });

    expect(window.addToast).toHaveBeenCalledTimes(1);
    expect(convertAllButton()).toHaveProperty('disabled', false);
    // The reload uses the provider that is current now, not the one captured at mount.
    expect(sendBridgeEvent).toHaveBeenCalledWith('deep_search_history', 'codex');
  });

  it('releases the guard when the backend never answers', () => {
    vi.useFakeTimers();
    try {
      renderBatchView();

      fireEvent.click(convertAllButton());
      expect(convertAllButton()).toHaveProperty('disabled', true);

      act(() => {
        vi.advanceTimersByTime(BATCH_CONVERSION_TIMEOUT_MS + 1);
      });

      // The answer is lost for good, so nothing but a watchdog can free the button.
      expect(window.addToast).toHaveBeenCalledWith('The conversion took too long', 'error');
      expect(convertAllButton()).toHaveProperty('disabled', false);
      expect(sendBridgeEvent).toHaveBeenCalledWith('deep_search_history', 'claude');

      fireEvent.click(convertAllButton());
      expect(batchCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the watchdog once the answer arrives', () => {
    vi.useFakeTimers();
    try {
      renderBatchView();

      fireEvent.click(convertAllButton());
      answerBatch({ status: 'completed', total: 50, converted: 50, skipped: 0, failed: 0 });

      act(() => {
        vi.advanceTimersByTime(BATCH_CONVERSION_TIMEOUT_MS * 2);
      });

      // A late watchdog would report a timeout for a run that actually succeeded.
      expect(window.addToast).toHaveBeenCalledTimes(1);
      expect(window.addToast).toHaveBeenCalledWith('50 session(s) converted', 'success');
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the guard at once and blames the bridge when the click is rejected', () => {
    vi.useFakeTimers();
    try {
      // A dead bridge rejects the event synchronously: nothing is in flight, so the run
      // must not wait out the watchdog or end up reported as a conversion timeout.
      (sendBridgeEvent as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
      renderBatchView();

      fireEvent.click(convertAllButton());

      expect(window.addToast).toHaveBeenCalledTimes(1);
      expect(window.addToast).toHaveBeenCalledWith(
        'The conversion could not be started: the plugin is not responding. Try again in a moment.',
        'error',
      );
      expect(convertAllButton()).toHaveProperty('disabled', false);

      act(() => {
        vi.advanceTimersByTime(BATCH_CONVERSION_TIMEOUT_MS + 1);
      });
      expect(window.addToast).toHaveBeenCalledTimes(1);

      // The guard really was released, not just re-disabled by the watchdog.
      fireEvent.click(convertAllButton());
      expect(batchCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts convertible sessions hidden by the search query', () => {
    vi.useFakeTimers();
    try {
      renderBatchView();

      fireEvent.change(screen.getByPlaceholderText('Search session titles...'), {
        target: { value: 'SDK session 7' },
      });
      act(() => {
        vi.advanceTimersByTime(400);
      });

      // Only one row is rendered, but the backend walks the whole project index, so the
      // button must still advertise all 50 and stay clickable.
      expect(screen.getByText('SDK session 7')).toBeTruthy();
      expect(screen.queryByText('SDK session 8')).toBeNull();
      expect(convertAllButton()).toHaveProperty('disabled', false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports convertible sessions when the search query hides all of them', () => {
    vi.useFakeTimers();
    try {
      renderBatchView();

      fireEvent.change(screen.getByPlaceholderText('Search session titles...'), {
        target: { value: 'nothing matches this' },
      });
      act(() => {
        vi.advanceTimersByTime(400);
      });

      // An empty list must not flip the button to the "nothing to convert" explanation.
      expect(convertAllButton()).toHaveProperty('disabled', false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the active session out of the count even when it is the only convertible one', () => {
    render(
      <HistoryView
        historyData={{
          success: true,
          total: 1,
          sessions: [
            {
              sessionId: ACTIVE_SESSION_ID,
              title: 'Active session',
              messageCount: 1,
              lastTimestamp: new Date().toISOString(),
              provider: 'claude',
              entrypoint: 'sdk-cli',
            },
          ],
        }}
        currentProvider="claude"
        currentSessionId={ACTIVE_SESSION_ID}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={vi.fn()}
      />,
    );

    // The active session is never a candidate, so with nothing else in the index the
    // count is zero and the button falls back to its disabled, explained state.
    const button = screen.getByRole('button', { name: 'No SDK or VS Code sessions to convert.' });
    expect(button).toHaveProperty('disabled', true);
  });
});

describe('HistoryView favorite visibility', () => {
  it('marks favorited session actions for persistent display', () => {
    render(
      <HistoryView
        historyData={{
          ...historyData,
          sessions: [
            {
              ...historyData.sessions![0],
              isFavorited: true,
              favoritedAt: Date.now(),
            },
            historyData.sessions![1],
          ],
        }}
        currentProvider="claude"
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onExportSession={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUpdateTitle={vi.fn()}
        onConvertToCliSession={vi.fn()}
      />,
    );

    const favoritedButton = screen.getByRole('button', { name: 'Unfavorite session' });
    const unfavoritedButton = screen.getByRole('button', { name: 'Favorite session' });

    expect(favoritedButton.closest('.history-action-buttons')?.classList.contains('has-favorite')).toBe(true);
    expect(unfavoritedButton.closest('.history-action-buttons')?.classList.contains('has-favorite')).toBe(false);
  });
});
