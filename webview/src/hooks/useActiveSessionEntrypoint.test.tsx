import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryData } from '../types';
import { SessionProvider, useSession } from '../contexts/SessionContext';
import { useActiveSessionEntrypoint } from './useActiveSessionEntrypoint';

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

// Imported after the mock so the hook picks up the mocked bridge.
const { sendBridgeEvent } = await import('../utils/bridge');

const Harness = ({
  sessionId,
  historyData,
  enabled = true,
}: {
  sessionId: string | null;
  historyData: HistoryData | null;
  enabled?: boolean;
}) => {
  const { setCurrentSessionId, setHistoryData } = useSession();
  React.useEffect(() => {
    setCurrentSessionId(sessionId);
    setHistoryData(historyData);
  }, [sessionId, historyData, setCurrentSessionId, setHistoryData]);
  useActiveSessionEntrypoint(enabled);
  return null;
};

const renderHook = (
  sessionId: string | null,
  historyData: HistoryData | null,
  enabled = true,
) =>
  render(
    <SessionProvider>
      <Harness sessionId={sessionId} historyData={historyData} enabled={enabled} />
    </SessionProvider>
  );

const historyWith = (sessionId: string, entrypoint?: string): HistoryData => ({
  success: true,
  sessions: [
    {
      sessionId,
      title: 'Session',
      messageCount: 1,
      ...(entrypoint !== undefined ? { entrypoint } : {}),
    },
  ],
});

const loadCalls = () =>
  (sendBridgeEvent as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([type]) => type === 'load_history_data');

/** How many reads the hook's ladder is allowed to make: one immediate + two retries. */
const RETRY_STEPS = 3;

describe('useActiveSessionEntrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    window.sendToJava = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests history metadata for a live session missing from the snapshot', () => {
    renderHook('active-session', null);

    expect(loadCalls()).toHaveLength(1);
    expect(sendBridgeEvent).toHaveBeenCalledWith('load_history_data', 'claude');
  });

  it('does nothing once the snapshot already describes the session', () => {
    renderHook('active-session', historyWith('active-session', 'sdk-cli'));

    expect(loadCalls()).toHaveLength(0);
  });

  it('treats a session present without an entrypoint as answered', () => {
    renderHook('active-session', historyWith('active-session'));

    expect(loadCalls()).toHaveLength(0);
  });

  it('does nothing without an active session', () => {
    renderHook(null, null);

    expect(loadCalls()).toHaveLength(0);
  });

  it('does nothing while disabled (non-chat view)', () => {
    renderHook('active-session', null, false);

    expect(loadCalls()).toHaveLength(0);
  });

  it('stops retrying once the snapshot arrives', () => {
    const { rerender } = renderHook('active-session', null);

    expect(loadCalls()).toHaveLength(1);

    rerender(
      <SessionProvider>
        <Harness sessionId="active-session" historyData={historyWith('active-session', 'sdk-cli')} />
      </SessionProvider>
    );

    act(() => { vi.advanceTimersByTime(10_000); });
    expect(loadCalls()).toHaveLength(1);
  });

  it('caps the retry ladder so a never-indexed session cannot loop forever', () => {
    renderHook('active-session', null);

    // Each retry schedules the next timer from inside the previous one's flush,
    // so the clock has to be advanced repeatedly rather than in one jump.
    for (let i = 0; i < RETRY_STEPS; i++) {
      act(() => { vi.advanceTimersByTime(10_000); });
    }
    act(() => { vi.advanceTimersByTime(60_000); });

    // One immediate read plus the two backed-off retries, then it gives up.
    expect(loadCalls()).toHaveLength(RETRY_STEPS);
  });

  it('skips providers that cannot carry a convertible entrypoint', () => {
    localStorage.setItem('model-selection-state', JSON.stringify({ provider: 'codex' }));

    renderHook('active-session', null);

    expect(loadCalls()).toHaveLength(0);
  });

  it('prefers the per-tab provider over the shared localStorage snapshot', () => {
    localStorage.setItem('model-selection-state', JSON.stringify({ provider: 'claude' }));
    window.__INITIAL_TAB_PROVIDER__ = 'codex';

    try {
      renderHook('active-session', null);
      expect(loadCalls()).toHaveLength(0);
    } finally {
      delete window.__INITIAL_TAB_PROVIDER__;
    }
  });
});
