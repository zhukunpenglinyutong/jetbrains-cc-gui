import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { HistoryData } from '../types';
import { useSessionManagement } from './useSessionManagement';
import { deleteCodexStorageSessions, lastMaintenanceId, receiveCodexStorageResponse } from '../components/settings/AiDataStorageSection/codexStorageBridge';

describe('confirmed Codex history and storage deletion', () => {
  const t = ((key: string) => key) as TFunction;
  const sent = vi.fn<(message: string) => void>();
  const request = () => JSON.parse((sent.mock.calls.at(-1)?.[0] ?? '').split(/:(.*)/s)[1]!) as { requestId: string; operationId: string };
  const setup = (loading = false) => {
    let history: HistoryData = { success: true, sessions: [{ sessionId: 'codex-idle', title: 'Codex', provider: 'codex', messageCount: 2 }], total: 2 };
    const mocks = {
      setHistoryData: vi.fn((value: React.SetStateAction<HistoryData | null>) => { history = (typeof value === 'function' ? value(history) : value)!; }),
      setMessages: vi.fn(), setCurrentView: vi.fn(), setCurrentSessionId: vi.fn(), setCustomSessionTitle: vi.fn(),
      setUsagePercentage: vi.fn(), setUsageUsedTokens: vi.fn(), setUsageMaxTokens: vi.fn(), setStatus: vi.fn(),
      setLoading: vi.fn(), setIsThinking: vi.fn(), setStreamingActive: vi.fn(), clearToasts: vi.fn(), addToast: vi.fn(),
    };
    const hook = renderHook(() => useSessionManagement({ messages: [], historyData: history, loading,
      currentSessionId: 'codex-idle', currentProvider: 'codex', ...mocks, t }));
    return { ...hook, mocks, history: () => history };
  };
  beforeEach(() => {
    sent.mockClear(); window.sendToJava = sent;
    localStorage.removeItem('ccgui.codex-storage.last-operation.v1');
    window.__sessionTransitioning = false; window.__pendingSessionTransitionToast = undefined;
  });

  it('keeps history until database/file deletion is confirmed', async () => {
    const hook = setup();
    act(() => hook.result.current.deleteHistorySession('codex-idle'));
    expect(sent.mock.calls[0]?.[0]).toMatch(/^delete_ai_storage_sessions:/);
    expect(sent.mock.calls[0]?.[0]).toContain('"origin":"history"');
    expect(lastMaintenanceId()).toBeNull();
    expect(hook.history().sessions).toHaveLength(1);
    expect(hook.mocks.setCurrentSessionId).not.toHaveBeenCalled();
    expect(hook.mocks.addToast).not.toHaveBeenCalled();
    const pending = request();
    await act(async () => receiveCodexStorageResponse(JSON.stringify({
      action: 'delete_ai_storage_sessions', requestId: pending.requestId, success: true,
      data: { operationId: pending.operationId, kind: 'DELETE_SESSIONS', state: 'COMPLETED', targets: ['codex-idle'],
        createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:01Z', result: { deletedSessionIds: ['codex-idle'] } },
    })));
    expect(hook.history().sessions).toHaveLength(0);
    expect(hook.mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(sent).toHaveBeenCalledWith('create_new_session:');
    expect(sent).not.toHaveBeenCalledWith('interrupt_session:');
    expect(sent).not.toHaveBeenCalledWith('delete_session:codex-idle');
    expect(window.__pendingSessionTransitionToast?.message).toBe('history.sessionDeleted');
  });

  it('refuses a running session without interrupting it or reporting success', () => {
    const hook = setup(true);
    act(() => hook.result.current.deleteHistorySessions(['codex-idle', 'codex-idle']));
    expect(sent).not.toHaveBeenCalled();
    expect(hook.history().sessions).toHaveLength(1);
    expect(hook.mocks.addToast).toHaveBeenCalledWith('settings.codexStorage.errors.SESSION_RUNNING', 'warning');
    expect(window.__pendingSessionTransitionToast).toBeUndefined();
  });

  it('deduplicates pending batch requests and keeps rows after backend failure', async () => {
    const previousMaintenance = '11111111-1111-1111-1111-111111111111';
    localStorage.setItem('ccgui.codex-storage.last-operation.v1', previousMaintenance);
    const hook = setup();
    act(() => {
      hook.result.current.deleteHistorySessions(['codex-idle', 'codex-idle']);
      hook.result.current.deleteHistorySession('codex-idle');
    });
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[0]).toContain('"sessionIds":["codex-idle"]');
    expect(sent.mock.calls[0]?.[0]).toContain('"origin":"history"');
    expect(lastMaintenanceId()).toBe(previousMaintenance);
    await act(async () => receiveCodexStorageResponse(JSON.stringify({
      action: 'delete_ai_storage_sessions', requestId: request().requestId, success: false, error: 'DATABASE_BUSY',
    })));
    expect(hook.history().sessions).toHaveLength(1);
    expect(hook.mocks.addToast).toHaveBeenCalledWith('settings.codexStorage.errors.DATABASE_BUSY', 'error');
    expect(hook.mocks.setCurrentSessionId).not.toHaveBeenCalled();
    expect(window.__pendingSessionTransitionToast).toBeUndefined();
  });

  it.each(['DATABASE_BUSY', 'MAINTENANCE_PLATFORM_UNSUPPORTED'])('keeps history intact after a failed %s receipt', async (error) => {
    const hook = setup();
    act(() => hook.result.current.deleteHistorySession('codex-idle'));
    const pending = request();
    await act(async () => receiveCodexStorageResponse(JSON.stringify({
      action: 'delete_ai_storage_sessions', requestId: pending.requestId, success: true,
      data: { operationId: pending.operationId, kind: 'DELETE_SESSIONS', state: 'FAILED_CLEAN', targets: ['codex-idle'],
        createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:01Z', error,
        result: { deletedSessionIds: ['codex-idle'] } },
    })));
    expect(hook.history().sessions).toHaveLength(1);
    expect(hook.mocks.addToast).toHaveBeenCalledWith(`settings.codexStorage.errors.${error}`, 'error');
    expect(hook.mocks.setCurrentSessionId).not.toHaveBeenCalled();
  });

  it('synchronizes only a confirmed storage deletion without changing the legacy request path', async () => {
    const hook = setup();
    await act(async () => {
      const deletion = deleteCodexStorageSessions(['codex-idle']);
      const pending = request();
      expect(sent.mock.calls[0]?.[0]).toMatch(/^delete_ai_storage_sessions:/);
      expect(hook.history().sessions).toHaveLength(1);
      receiveCodexStorageResponse(JSON.stringify({ action: 'delete_ai_storage_sessions', requestId: pending.requestId, success: true,
        data: { operationId: pending.operationId, kind: 'DELETE_SESSIONS', state: 'COMPLETED', targets: ['codex-idle'],
          createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:01Z', result: { deletedSessionIds: ['codex-idle'] } } }));
      await deletion;
    });
    expect(hook.history().sessions).toHaveLength(0);
    expect(hook.mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(sent).toHaveBeenCalledWith('create_new_session:');
    expect(sent).not.toHaveBeenCalledWith('delete_session:codex-idle');
  });

  it('does not duplicate storage errors through the legacy history hook', async () => {
    const hook = setup();
    await act(async () => {
      const deletion = deleteCodexStorageSessions(['codex-idle']);
      const rejected = expect(deletion).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
      receiveCodexStorageResponse(JSON.stringify({ action: 'delete_ai_storage_sessions', requestId: request().requestId, success: false, error: 'SESSION_RUNNING' }));
      await rejected;
    });
    expect(hook.history().sessions).toHaveLength(1);
    expect(hook.mocks.setCurrentSessionId).not.toHaveBeenCalled();
    expect(hook.mocks.addToast).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalledWith('interrupt_session:');
  });
});
