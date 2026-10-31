import { startupHistoryStateForSession, type StartupHistoryLoadState } from './startupHistory';

describe('restored history session transitions', () => {
  const unloaded: StartupHistoryLoadState = {
    status: 'unloaded', sessionId: 'restored', requestId: '', generation: 1, messageCount: 0, retryable: true,
  };

  it('does not revive an unloaded banner when history is reopened after New Session', () => {
    const fresh = startupHistoryStateForSession(unloaded, null);
    expect(fresh).toBeNull();
    expect(startupHistoryStateForSession(fresh, 'restored')).toBeNull();
  });

  it('keeps the missing-history explanation only on the fresh or matching session', () => {
    const missing = { ...unloaded, status: 'missing' as const, retryable: false };
    expect(startupHistoryStateForSession(missing, null)).toBe(missing);
    expect(startupHistoryStateForSession(missing, 'another')).toBeNull();
  });
});
