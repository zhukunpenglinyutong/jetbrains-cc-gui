import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryData } from '../../types';
import type { CodexStorageMutationStatus } from '../settings/AiDataStorageSection/codexStorageBridge';
import { sendBridgeEvent } from '../../utils/bridge';
import HistoryView from './HistoryView';

const activity = vi.hoisted(() => ({ status: null as CodexStorageMutationStatus | null, observe: vi.fn() }));
vi.mock('../settings/AiDataStorageSection/useCodexStorageMutationStatus', () => ({
  useCodexStorageMutationStatus: (enabled: boolean) => {
    activity.observe(enabled);
    return { status: activity.status };
  },
}));

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
  activity.status = null;
});

describe('HistoryView native message counts', () => {
  const actions = { currentProvider: 'codex', onLoadSession: vi.fn(), onDeleteSession: vi.fn(),
    onDeleteSessions: vi.fn(), onExportSession: vi.fn(), onToggleFavorite: vi.fn(), onUpdateTitle: vi.fn(), onConvertToCliSession: vi.fn() };

  it('disables deletion and selection only for running targets, leaving idle sessions deletable', () => {
    const onDeleteSessions = vi.fn();
    const data: HistoryData = { success: true, source: 'native', sessions: [
      { sessionId: 'busy', title: 'Running target', provider: 'codex', running: true },
      { sessionId: 'idle', title: 'Idle target', provider: 'codex' },
    ] };
    const { container } = render(<HistoryView {...actions} onDeleteSessions={onDeleteSessions} historyData={data} />);
    const buttons = container.querySelectorAll<HTMLButtonElement>('.history-delete-btn');
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(false);
    fireEvent.click(buttons[0]);
    expect(screen.queryByText('common.confirmDelete')).toBeNull();
    fireEvent.click(screen.getByText('Select'));
    expect((screen.getByLabelText('Select Running target') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Select all'));
    fireEvent.click(screen.getByText('Delete selected'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteSessions).toHaveBeenCalledWith(['idle']);
  });

  it('closes an outstanding delete confirmation when the target starts a turn', () => {
    const onDeleteSession = vi.fn();
    const data: HistoryData = { success: true, sessions: [{ sessionId: 'target', title: 'Target', provider: 'codex' }] };
    const { container, rerender } = render(<HistoryView {...actions} historyData={data} currentSessionId="target"
      currentSessionBusy={false} onDeleteSession={onDeleteSession} />);
    fireEvent.click(container.querySelector('.history-delete-btn')!);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    rerender(<HistoryView {...actions} historyData={data} currentSessionId="target"
      currentSessionBusy onDeleteSession={onDeleteSession} />);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(onDeleteSession).not.toHaveBeenCalled();
  });

  it('unlocks a fetched running row after the host confirms its current turn is idle', () => {
    const onDeleteSession = vi.fn();
    const onDeleteSessions = vi.fn();
    const data: HistoryData = { success: true, source: 'native', sessions: [
      { sessionId: 'target', title: 'Finished target', provider: 'codex', running: true },
      { sessionId: 'other', title: 'Still running', provider: 'codex', running: true },
    ] };
    const props = { ...actions, historyData: data, currentSessionId: 'target', onDeleteSession, onDeleteSessions };
    const { container, rerender } = render(<HistoryView {...props} currentSessionBusy />);
    expect(container.querySelector<HTMLButtonElement>('.history-delete-btn')!.disabled).toBe(true);
    activity.status = { available: false, unavailableReason: 'SESSION_RUNNING', deletionAvailable: true,
      runningSessionIds: ['other'], writerSessionIds: ['other'] };
    rerender(<HistoryView {...props} currentSessionBusy={false} />);
    expect(container.querySelectorAll<HTMLButtonElement>('.history-delete-btn')[0].disabled).toBe(false);
    expect(container.querySelectorAll<HTMLButtonElement>('.history-delete-btn')[1].disabled).toBe(true);
    fireEvent.click(container.querySelector('.history-delete-btn')!);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteSession).toHaveBeenCalledWith('target');
    fireEvent.click(screen.getByText('Select'));
    expect((screen.getByLabelText('Select Finished target') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Select Still running') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Select all'));
    fireEvent.click(screen.getByText('Delete selected'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteSessions).toHaveBeenCalledWith(['target']);
  });

  it.each(['pending-question', 'native-writer', 'failed-status', 'fresh-turn'])('keeps a current running row protected for %s', reason => {
    activity.status = { available: true, deletionAvailable: true,
      runningSessionIds: reason === 'pending-question' ? ['target'] : [],
      writerSessionIds: reason === 'native-writer' ? ['target'] : [] };
    if (reason === 'failed-status') activity.status = { available: false, deletionAvailable: false,
      deletionUnavailableReason: 'STORAGE_RESPONSE_TIMEOUT', runningSessionIds: [], writerSessionIds: [] };
    const data: HistoryData = { success: true, source: 'native', sessions: [
      { sessionId: 'target', title: 'Protected target', provider: 'codex', running: true },
    ] };
    const { container } = render(<HistoryView {...actions} historyData={data} currentSessionId="target"
      currentSessionBusy={reason === 'fresh-turn'} />);
    expect(container.querySelector<HTMLButtonElement>('.history-delete-btn')!.disabled).toBe(true);
    fireEvent.click(screen.getByText('Select'));
    expect((screen.getByLabelText('Select Protected target') as HTMLInputElement).disabled).toBe(true);
  });

  it.each(['observer', null])('reconciles other tabs in the existing history with current session %s', currentSessionId => {
    const onDeleteSessions = vi.fn();
    const data: HistoryData = { success: true, source: 'native', sessions: [
      { sessionId: 'target', title: 'Other tab', provider: 'codex', running: true },
      { sessionId: 'waiting', title: 'Pending question', provider: 'codex', running: true },
      { sessionId: 'fresh', title: 'New turn', provider: 'codex', running: false },
      { sessionId: 'claude', title: 'Claude turn', provider: 'claude', running: true },
    ] };
    const props = { ...actions, historyData: data, currentSessionId, onDeleteSessions };
    const { rerender } = render(<HistoryView {...props} />);
    expect(activity.observe).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByText('Select'));
    expect(screen.getByLabelText('Select Other tab')).toHaveProperty('disabled', true);

    activity.status = { available: false, unavailableReason: 'SESSION_RUNNING', deletionAvailable: true,
      runningSessionIds: ['waiting', 'fresh'], writerSessionIds: ['target', 'waiting', 'fresh'] };
    rerender(<HistoryView {...props} />);
    // An idle loaded thread in another tab can retain its native writer lease.
    expect(screen.getByLabelText('Select Other tab')).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Select Pending question')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Select New turn')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Select Claude turn')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText('Select Other tab'));

    // A new turn must invalidate a selection made before the next activity update.
    activity.status = { ...activity.status, runningSessionIds: ['target', 'waiting', 'fresh'] };
    rerender(<HistoryView {...props} />);
    expect(screen.getByLabelText('Select Other tab')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Select Other tab')).toHaveProperty('checked', false);

    activity.status = { ...activity.status, runningSessionIds: ['waiting', 'fresh'] };
    rerender(<HistoryView {...props} />);
    fireEvent.click(screen.getByText('Select all'));
    fireEvent.click(screen.getByText('Delete selected'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteSessions).toHaveBeenCalledWith(['target']);
  });

  it.each([null, { available: false, deletionAvailable: false, runningSessionIds: [], writerSessionIds: [] }])(
    'keeps other running tabs protected without a confirmed activity snapshot', status => {
      activity.status = status;
      render(<HistoryView {...actions} currentSessionId="observer" historyData={{ success: true, sessions: [
        { sessionId: 'other', title: 'Unconfirmed target', provider: 'codex', running: true },
      ] }} />);
      fireEvent.click(screen.getByText('Select'));
      expect(screen.getByLabelText('Select Unconfirmed target')).toHaveProperty('disabled', true);
    },
  );

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
