import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryData } from '../../types';
import { sendBridgeEvent } from '../../utils/bridge';
import HistoryView from './HistoryView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'history.totalSessions': `${options?.count} sessions · ${options?.total} messages`,
        'history.totalSessionsOnly': `${options?.count} sessions`,
        'history.messageCount': `${options?.count} messages`,
        'history.messageCountUnknown': 'Message count unavailable',
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
  sendBridgeEvent: vi.fn(),
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

describe('HistoryView native message counts', () => {
  const actions = { currentProvider: 'codex', onLoadSession: vi.fn(), onDeleteSession: vi.fn(),
    onDeleteSessions: vi.fn(), onExportSession: vi.fn(), onToggleFavorite: vi.fn(), onUpdateTitle: vi.fn(), onConvertToCliSession: vi.fn() };

  it('distinguishes unknown counts from zero and shows a message total only when known', () => {
    const data: HistoryData = { ...historyData, source: 'native', total: undefined,
      sessions: [{ ...historyData.sessions![0], messageCount: undefined }, { ...historyData.sessions![1], messageCount: 0 }] };
    const { rerender } = render(<HistoryView {...actions} historyData={data} />);
    expect(screen.getByText('Message count unavailable')).toBeTruthy();
    expect(screen.getByText('0 messages')).toBeTruthy();
    expect(screen.getByText('2 sessions')).toBeTruthy();
    expect(screen.queryByText('2 sessions · 2 messages')).toBeNull();
    rerender(<HistoryView {...actions} historyData={{ ...data, total: 7,
      sessions: [{ ...data.sessions![0], messageCount: 7 }, data.sessions![1]] }} />);
    expect(screen.getByText('7 messages')).toBeTruthy();
    expect(screen.getByText('2 sessions · 7 messages')).toBeTruthy();
    expect(screen.queryByText('Message count unavailable')).toBeNull();
  });

  it('does not turn overlapping metadata-only rows into a counted zero', () => {
    const session = { ...historyData.sessions![0], messageCount: undefined };
    render(<HistoryView {...actions} historyData={{ success: true, source: 'native', sessions: [session, { ...session }] }} />);
    expect(screen.getByText('Message count unavailable')).toBeTruthy();
    expect(screen.getByText('1 sessions')).toBeTruthy();
    expect(screen.queryByText('0 messages')).toBeNull();
  });

  it('does not borrow an older count when the latest native revision is unknown or empty', () => {
    const older = { ...historyData.sessions![0], lastTimestamp: '2026-10-01T00:00:00Z', nativeRevision: 'old', messageCount: 7 };
    const newer = { ...older, lastTimestamp: '2026-10-02T00:00:00Z', nativeRevision: 'new', messageCount: undefined };
    const { rerender } = render(<HistoryView {...actions} historyData={{ success: true, source: 'native', sessions: [older, newer] }} />);
    expect(screen.getByText('Message count unavailable')).toBeTruthy();
    expect(screen.queryByText('7 messages')).toBeNull();
    rerender(<HistoryView {...actions} historyData={{ success: true, source: 'native', sessions: [older, { ...newer, messageCount: 0 }] }} />);
    expect(screen.getByText('0 messages')).toBeTruthy();
    expect(screen.queryByText('7 messages')).toBeNull();
  });
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
