import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteCodexHistorySessions, deleteCodexStorageSessions, newMaintenanceId, receiveCodexStorageResponse, storageRequest, subscribeCodexDeletion,
} from './codexStorageBridge';

interface Request { requestId: string; operationId: string; provider: string; sessionIds: string[] }
const sent = vi.fn<(message: string) => void>();
const lastRequest = (): Request => {
  const call = sent.mock.calls.at(-1)?.[0] ?? '';
  return JSON.parse(call.slice(call.indexOf(':') + 1)) as Request;
};
const completed = (id: string) => ({ operationId: id, kind: 'DELETE_SESSIONS', state: 'COMPLETED', targets: ['one'],
  createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:01Z', result: { deletedSessionIds: ['one'] } });

beforeEach(() => { sent.mockClear(); window.sendToJava = sent; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Codex storage bridge', () => {
  it('validates optional lineage metadata while accepting sessions from older hosts', async () => {
    const response = storageRequest('list_ai_storage_sessions');
    const request = lastRequest();
    const row = { sessionId: 'child', title: 'Child', cwd: '/project', storageMode: 'file', running: false,
      archived: false, readable: true, fileSize: 10, lastTimestamp: 2, firstTimestamp: 1 };
    const data = { sessions: [row], total: 1, page: 1, pageSize: 10, hasMore: false, complete: true, errors: [] };
    let settled = false;
    void response.then(() => { settled = true; });
    for (const invalid of [{ subagent: 'true' }, { parentId: 1 }, { parentId: ' ' }, { parentTitle: {} },
      { parentAvailable: 1 }, { parentIsSubagent: 'false' }, { childCount: -1 }, { childCount: 1.5 }]) {
      receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'list_ai_storage_sessions', success: true,
        data: { ...data, sessions: [{ ...row, ...invalid }] } }));
      await Promise.resolve();
      expect(settled).toBe(false);
    }
    const lineage = { ...row, subagent: true, parentId: 'parent', parentTitle: 'Main',
      parentAvailable: true, parentIsSubagent: false, childCount: 2 };
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'list_ai_storage_sessions', success: true,
      data: { ...data, sessions: [lineage, row], total: 2 } }));
    await expect(response).resolves.toMatchObject({ sessions: [lineage, row] });
  });

  it('correlates location acknowledgements and propagates missing history file errors', async () => {
    const response = storageRequest('reveal_ai_storage_session', { sessionId: 'one' });
    const request = lastRequest();
    expect(sent.mock.calls.at(-1)?.[0]).toMatch(/^reveal_ai_storage_session:/);
    expect(request).toMatchObject({ provider: 'codex', sessionId: 'one' });
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'reveal_ai_storage_session', success: true, data: {} }));
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'reveal_ai_storage_session', success: true, data: { sessionId: 'one' } }));
    await expect(response).resolves.toEqual({ sessionId: 'one' });
    const missing = storageRequest('reveal_ai_storage_session', { sessionId: 'deleted' });
    receiveCodexStorageResponse(JSON.stringify({ ...lastRequest(), action: 'reveal_ai_storage_session', success: false, error: 'SESSION_FILE_NOT_FOUND' }));
    await expect(missing).rejects.toMatchObject({ code: 'SESSION_FILE_NOT_FOUND' });
  });

  it('dispatches maintenance and history deletion when an embedded browser lacks randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const id = newMaintenanceId();
    const anotherId = newMaintenanceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(anotherId).not.toBe(id);
    expect(localStorage.getItem('ccgui.codex-storage.last-operation.v1')).toBe(anotherId);
    const response = deleteCodexHistorySessions(['one']);
    const request = lastRequest();
    expect(request).toMatchObject({ origin: 'history', sessionIds: ['one'], provider: 'codex' });
    expect(request.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    receiveCodexStorageResponse(JSON.stringify({ action: 'delete_ai_storage_sessions', requestId: request.requestId,
      success: true, data: completed(request.operationId) }));
    await expect(response).resolves.toMatchObject({ state: 'COMPLETED' });
    expect(localStorage.getItem('ccgui.codex-storage.last-operation.v1')).toBe(anotherId);
  });

  it('requires independent maintenance and deletion admission with complete target protection', async () => {
    const response = storageRequest('get_ai_storage_mutation_status');
    const request = lastRequest();
    const data = { available: false, unavailableReason: 'SESSION_RUNNING', deletionAvailable: true,
      runningSessionIds: ['active'], writerSessionIds: ['native-idle'] };
    for (const invalid of [{ available: 'false' }, { available: false }, { available: false, unavailableReason: '' },
      { ...data, available: true }, { ...data, deletionAvailable: 'true' }, { ...data, deletionAvailable: false },
      { ...data, deletionUnavailableReason: 'DATABASE_BUSY' }, { ...data, runningSessionIds: undefined },
      { ...data, writerSessionIds: [3] }]) {
      receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'get_ai_storage_mutation_status', success: true, data: invalid }));
    }
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'get_ai_storage_mutation_status', success: true, data }));
    await expect(response).resolves.toEqual(data);
  });

  it('validates an orphan preview before accepting a cleanup capability', async () => {
    const response = storageRequest('preview_ai_storage_orphans');
    const request = lastRequest();
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'preview_ai_storage_orphans', success: true,
      data: { databaseId: 'registered', previewToken: '../unsafe', candidateCount: 1 } }));
    const data = { databaseId: 'registered', previewToken: 'a'.repeat(64), candidateCount: 1, rowCount: 10, estimatedBytes: 100,
      retainedFileSessions: 17, skippedBusyCount: 0, skippedExistingCount: 0, candidates: [{ sessionId: 'stale', title: 'Stale', estimatedBytes: 100 }] };
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'preview_ai_storage_orphans', success: true, data }));
    await expect(response).resolves.toEqual(data);
  });

  it('correlates action and request ID and rejects malformed content without resolving another request', async () => {
    const response = storageRequest('list_ai_storage_sessions');
    const request = lastRequest();
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'get_ai_storage_usage', success: true, data: {} }));
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'list_ai_storage_sessions', success: true, data: { sessions: 'invalid' } }));
    const data = { sessions: [], total: 0, page: 1, pageSize: 10, hasMore: false, complete: true, errors: [] };
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'list_ai_storage_sessions', success: true, data }));
    await expect(response).resolves.toEqual(data);
  });

  it('rejects invalid page metadata before accepting a paginated response', async () => {
    const response = storageRequest('list_ai_storage_sessions', { page: 3, limit: 15 });
    const request = lastRequest();
    const data = { sessions: [], total: 0, page: 1, pageSize: 15, hasMore: false, complete: true, errors: [] };
    for (const invalid of [{ page: 0 }, { page: 1.5 }, { pageSize: 0 }, { pageSize: 101 }, { total: -1 }]) {
      receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'list_ai_storage_sessions', success: true, data: { ...data, ...invalid } }));
    }
    receiveCodexStorageResponse(JSON.stringify({ ...request, action: 'list_ai_storage_sessions', success: true, data }));
    await expect(response).resolves.toEqual(data);
  });

  it('persists the operation ID before dispatch and emits confirmed deletion only once on replay', async () => {
    const operationId = newMaintenanceId();
    expect(localStorage.getItem('ccgui.codex-storage.last-operation.v1')).toBe(operationId);
    const listener = vi.fn();
    const unsubscribe = subscribeCodexDeletion(listener);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = deleteCodexStorageSessions(['one'], operationId);
        expect(sent.mock.calls.at(-1)?.[0]).toMatch(/^delete_ai_storage_sessions:/);
        const request = lastRequest();
        expect(request).toMatchObject({ operationId, sessionIds: ['one'], provider: 'codex' });
        receiveCodexStorageResponse(JSON.stringify({ action: 'delete_ai_storage_sessions', requestId: request.requestId, success: true, data: completed(operationId) }));
        await expect(response).resolves.toMatchObject({ state: 'COMPLETED' });
      }
      expect(listener).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it('keeps the operation identity after a lost response and exposes a queryable timeout', async () => {
    vi.useFakeTimers();
    const id = newMaintenanceId();
    const response = deleteCodexStorageSessions(['one'], id);
    const rejected = expect(response).rejects.toMatchObject({ code: 'STORAGE_RESPONSE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(120001);
    await rejected;
    expect(localStorage.getItem('ccgui.codex-storage.last-operation.v1')).toBe(id);
    expect(sent).toHaveBeenCalledOnce();
  });

  it('propagates backend refusal without emitting a deletion event', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCodexDeletion(listener);
    try {
      const response = deleteCodexStorageSessions(['one']);
      receiveCodexStorageResponse(JSON.stringify({ action: 'delete_ai_storage_sessions', requestId: lastRequest().requestId, success: false, error: 'SESSION_RUNNING' }));
      await expect(response).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
      expect(listener).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
});
