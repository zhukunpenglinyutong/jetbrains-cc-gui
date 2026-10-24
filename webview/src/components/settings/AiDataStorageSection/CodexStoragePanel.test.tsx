import { act, fireEvent, render as renderReact, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import ConfigProvider from 'antd/es/config-provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CodexStoragePanel, { storageBytes } from './CodexStoragePanel';
import { CodexStorageError } from './codexStorageBridge';
import type { CodexMaintenanceOperation, CodexStorageMutationStatus, CodexStorageSession } from './codexStorageBridge';

const render = (ui: ReactElement) => renderReact(ui, {
  wrapper: ({ children }) => <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>,
});

const mocks = vi.hoisted(() => ({
  request: vi.fn(), deleteSessions: vi.fn(), nextId: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('./codexStorageBridge', async importOriginal => {
  const original = await importOriginal<typeof import('./codexStorageBridge')>();
  return { ...original, storageRequest: mocks.request, deleteCodexStorageSessions: mocks.deleteSessions,
    newMaintenanceId: mocks.nextId, subscribeCodexDeletion: () => () => undefined };
});
const row = (id: string, running = false): CodexStorageSession => ({
  sessionId: id, title: id, cwd: '/project/' + id, storageMode: 'database', fileSize: 0,
  firstTimestamp: 1, lastTimestamp: 2, archived: false, running, readable: true,
});
const paginate = (sessions: CodexStorageSession[], fields?: Record<string, unknown>) => {
  const pageSize = Number(fields?.limit ?? 10);
  const page = Math.min(Number(fields?.page ?? 1), Math.max(1, Math.ceil(sessions.length / pageSize)));
  const offset = (page - 1) * pageSize;
  return { sessions: sessions.slice(offset, offset + pageSize), total: sessions.length, page, pageSize,
    hasMore: offset + pageSize < sessions.length, nextCursor: 'unused-cursor', complete: true, errors: [] };
};
const operation = (state = 'COMPLETED'): CodexMaintenanceOperation => ({
  operationId: '04aa435b-dc10-4b27-bd7b-e5c2e517ea51', kind: 'DELETE_SESSIONS', state,
  targets: ['idle'], createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:01Z',
  ...(state === 'COMPLETED' ? { result: { deletedSessionIds: ['idle'], rolloutBytesRemoved: 0 } } : {}),
});
let operations: CodexMaintenanceOperation[];
let sessionRows: CodexStorageSession[];
let mutationStatus: CodexStorageMutationStatus;
const storageStatus = (fields: Partial<CodexStorageMutationStatus> = {}): CodexStorageMutationStatus => ({
  available: true, deletionAvailable: true, runningSessionIds: [], writerSessionIds: [], ...fields,
});
const multiplePages = () => [row('running'), row('idle'), ...Array.from({ length: 8 }, (_, index) => row(`extra-${index}`)), row('next')];
beforeEach(() => {
  operations = [];
  sessionRows = [row('running'), row('idle')];
  mutationStatus = storageStatus();
  vi.clearAllMocks();
  mocks.nextId.mockReturnValue(operation().operationId);
  mocks.deleteSessions.mockResolvedValue(operation());
  mocks.request.mockImplementation(async (action: string, fields?: Record<string, unknown>) => {
    switch (action) {
      case 'get_ai_storage_mutation_status': return mutationStatus;
      case 'get_ai_storage_usage': return { canonicalRoot: 'home', physicalRoot: 'disk', scannedAt: '2026-10-16T00:00:00Z', logicalBytes: 100,
        categories: { historyDatabase: 100 }, skippedLinks: [], errors: [], complete: true };
      case 'get_ai_storage_database_status': return { databaseId: 'registered', name: 'thread_history_1.sqlite', supported: true, maintenancePending: false,
        sizes: { mainBytes: 100, walBytes: 0 }, freelistCount: 0, pageSize: 4096 };
      case 'list_ai_storage_maintenance_operations': return operations;
      case 'list_ai_storage_sessions': return paginate(sessionRows, fields);
      case 'get_ai_storage_session': return { sessionId: fields?.sessionId, records: [{ text: 'bounded content', truncated: true }], hasMore: false };
      case 'reveal_ai_storage_session': return { sessionId: fields?.sessionId };
      case 'preview_ai_storage_orphans': return { databaseId: 'registered', previewToken: 'a'.repeat(64), candidateCount: 2,
        rowCount: 100, estimatedBytes: 2 ** 20, retainedFileSessions: 3, skippedBusyCount: 0, skippedExistingCount: 0,
        candidates: [{ sessionId: 'stale', title: 'Stale', estimatedBytes: 2 ** 20 }] };
      case 'clean_ai_storage_orphans': {
        const cleaned: CodexMaintenanceOperation = { ...operation(), kind: 'CLEAN_ORPHANED_HISTORY', targets: [String(fields?.previewToken)],
          result: { cleanedSessionCount: 2, releasedBytes: 4096 } };
        operations = [cleaned];
        return cleaned;
      }
      default: throw new Error(action);
    }
  });
});

describe('Codex storage settings', () => {
  it('keeps parent identity in the session list and content preview without changing busy-session guards', async () => {
    sessionRows = [{ ...row('running', true), childCount: 1 }, { ...row('child'), subagent: true,
      parentId: 'running', parentTitle: 'Main session outside this page', parentAvailable: true }];
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_RUNNING', runningSessionIds: ['running'] });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/child');
    const child = screen.getByText('/project/child').parentElement!.parentElement!;
    const parent = screen.getByText('/project/running').parentElement!.parentElement!;
    expect(within(child).getByText('settings.codexStorage.relations.subagent')).toBeTruthy();
    expect(within(child).getByText('Main session outside this page')).toBeTruthy();
    expect((within(parent).getByRole('button', { name: 'common.delete' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(child).getByRole('button', { name: 'settings.codexStorage.view' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Main session outside this page')).toBeTruthy();
    expect(within(dialog).getByText('settings.codexStorage.relations.subagent')).toBeTruthy();
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
  });

  it('locates archived and running files independently of deletion and content availability', async () => {
    sessionRows = [{ ...row('archive'), archived: true }, { ...row('running', true), readable: false }];
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_RUNNING', runningSessionIds: ['running'] });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/archive');
    for (const id of ['archive', 'running']) {
      const item = screen.getByText(`/project/${id}`).parentElement!.parentElement!;
      const button = within(item).getByRole('button', { name: 'settings.codexStorage.openLocation' });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button);
      await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('reveal_ai_storage_session', { sessionId: id }));
    }
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(([action]) => action === 'get_ai_storage_session')).toBe(false);
  });

  it.each([
    ['SESSION_FILE_NOT_FOUND', 'settings.codexStorage.errors.SESSION_FILE_NOT_FOUND'],
    ['STORAGE_RESPONSE_TIMEOUT', 'settings.codexStorage.openLocationTimeout'],
  ])('shows pending location feedback and allows retry after %s', async (code, message) => {
    const addToast = vi.fn();
    const normal = mocks.request.getMockImplementation()!;
    let rejectLocation: (error: CodexStorageError) => void = () => undefined;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'reveal_ai_storage_session'
      ? new Promise((_resolve, reject) => { rejectLocation = reject; }) : normal(action, fields));
    render(<CodexStoragePanel addToast={addToast} />);
    await screen.findByText('/project/idle');
    const item = screen.getByText('/project/idle').parentElement!.parentElement!;
    const button = within(item).getByRole('button', { name: 'settings.codexStorage.openLocation' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.request.mock.calls.filter(([action]) => action === 'reveal_ai_storage_session')).toHaveLength(1);
    await act(async () => rejectLocation(new CodexStorageError(code)));
    expect(addToast).toHaveBeenCalledWith(message, 'error');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    mocks.request.mockImplementation(normal);
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));
    expect(mocks.request.mock.calls.filter(([action]) => action === 'reveal_ai_storage_session')).toHaveLength(2);
  });

  it('forgets a removed maintenance receipt while preserving host-discovered pending operations', async () => {
    const remembered = operation().operationId;
    localStorage.setItem('ccgui.codex-storage.last-operation.v1', remembered);
    operations = [{ ...operation('RECONCILIATION_REQUIRED'), operationId: 'pending', kind: 'COMPACT_DATABASE' }];
    const request = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (action: string, fields?: Record<string, unknown>) => {
      if (action === 'get_ai_storage_maintenance_operation') throw new CodexStorageError('OPERATION_NOT_FOUND');
      return request(action, fields);
    });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('settings.codexStorage.states.RECONCILIATION_REQUIRED');
    await waitFor(() => expect(localStorage.getItem('ccgui.codex-storage.last-operation.v1')).toBeNull());
    await waitFor(() => expect(screen.getByLabelText<HTMLButtonElement>('common.refresh', { selector: 'button' }).disabled).toBe(false));
    mocks.request.mockClear();
    fireEvent.click(screen.getByLabelText<HTMLButtonElement>('common.refresh', { selector: 'button' }));
    await waitFor(() => expect(screen.getByLabelText<HTMLButtonElement>('common.refresh', { selector: 'button' }).disabled).toBe(false));
    expect(mocks.request.mock.calls.some(([action]) => action === 'get_ai_storage_maintenance_operation')).toBe(false);
    expect(screen.getByText('settings.codexStorage.states.RECONCILIATION_REQUIRED')).toBeTruthy();
  });

  it('previews stale history and requires irreversible confirmation before cleanup', async () => {
    const addToast = vi.fn();
    render(<CodexStoragePanel addToast={addToast} />);
    await screen.findByText('/project/idle');
    expect(mocks.request).not.toHaveBeenCalledWith('preview_ai_storage_orphans');
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('settings.codexStorage.orphans.irreversible')).toBeTruthy();
    expect(mocks.request.mock.calls.filter(([action]) => action === 'clean_ai_storage_orphans')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.cancel' }));
    expect(mocks.request.mock.calls.filter(([action]) => action === 'clean_ai_storage_orphans')).toHaveLength(0);
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    const reopened = await screen.findByRole('dialog');
    fireEvent.click(within(reopened).getByRole('button', { name: 'settings.codexStorage.orphans.confirm' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('clean_ai_storage_orphans', {
      operationId: operation().operationId, databaseId: 'registered', previewToken: 'a'.repeat(64),
    }));
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('settings.codexStorage.orphans.cleanedCount · settings.codexStorage.released', 'success'));
    expect(screen.queryByText('settings.codexStorage.states.COMPLETED')).toBeNull();
  });

  it('shows a non-destructive empty result and opens compaction details without running maintenance', async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (action: string, fields?: Record<string, unknown>) => {
      const value = await normal(action, fields);
      return action === 'preview_ai_storage_orphans' ? { ...value, candidateCount: 0, rowCount: 0, estimatedBytes: 0, candidates: [] } : value;
    });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    const compaction = screen.getByText('thread_history_1.sqlite').closest('[role="group"]')!;
    const advanced = compaction.closest('details') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('settings.codexStorage.orphans.analysisTitle')).toBeTruthy();
    expect(within(dialog).getByText('settings.codexStorage.orphans.none')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'settings.codexStorage.orphans.confirm' })).toBeNull();
    expect(within(dialog).queryByText('settings.codexStorage.orphans.irreversible')).toBeNull();
    expect(within(dialog).queryByText('settings.codexStorage.orphans.summary')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(advanced.open).toBe(false);
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    const reopened = await screen.findByRole('dialog');
    fireEvent.click(within(reopened).getByRole('button', { name: 'settings.codexStorage.orphans.openCompaction' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(advanced.open).toBe(true);
    expect(document.activeElement).toBe(compaction);
    expect(mocks.request.mock.calls.filter(([action]) => ['clean_ai_storage_orphans', 'compact_ai_storage_database'].includes(action))).toHaveLength(0);
  });

  it('shows cleanup progress before the first host result and keeps it until completion', async () => {
    const normal = mocks.request.getMockImplementation()!;
    let completeCleanup!: (value: CodexMaintenanceOperation) => void;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'clean_ai_storage_orphans'
      ? new Promise<CodexMaintenanceOperation>(resolve => { completeCleanup = resolve; }) : normal(action, fields));
    const addToast = vi.fn();
    render(<CodexStoragePanel addToast={addToast} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'settings.codexStorage.orphans.confirm' }));
    await waitFor(() => expect(completeCleanup).toBeTypeOf('function'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('settings.codexStorage.processing').closest('[role="status"]')).toBeTruthy();
    expect(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }).disabled).toBe(true);
    await act(async () => {
      const cleaned: CodexMaintenanceOperation = { ...operation(), kind: 'CLEAN_ORPHANED_HISTORY', result: { cleanedSessionCount: 2, releasedBytes: 4096 } };
      operations = [cleaned];
      completeCleanup(cleaned);
    });
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('settings.codexStorage.orphans.cleanedCount · settings.codexStorage.released', 'success'));
    expect(screen.queryByText('settings.codexStorage.processing')).toBeNull();
  });

  it('shows the admission check while cleanup is waiting to be submitted', async () => {
    const normal = mocks.request.getMockImplementation()!;
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    const dialog = await screen.findByRole('dialog');
    let admit!: (value: CodexStorageMutationStatus) => void;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'get_ai_storage_mutation_status'
      ? new Promise<CodexStorageMutationStatus>(resolve => { admit = resolve; }) : normal(action, fields));
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.codexStorage.orphans.confirm' }));
    await waitFor(() => expect(admit).toBeTypeOf('function'));
    expect(screen.getByText('settings.codexStorage.checkingAvailability').closest('[role="status"]')).toBeTruthy();
    expect(mocks.nextId).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.filter(([action]) => action === 'clean_ai_storage_orphans')).toHaveLength(0);
    await act(async () => { admit(storageStatus()); });
    await waitFor(() => expect(mocks.request.mock.calls.filter(([action]) => action === 'clean_ai_storage_orphans')).toHaveLength(1));
  });

  it('reports a cleanup admission change after confirmation without dispatching a mutation', async () => {
    const addToast = vi.fn();
    render(<CodexStoragePanel addToast={addToast} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    const dialog = await screen.findByRole('dialog');
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_WRITER_BUSY', writerSessionIds: ['other-client'] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.codexStorage.orphans.confirm' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('settings.codexStorage.errors.SESSION_WRITER_BUSY', 'error'));
    expect(screen.getByRole('alert').textContent).toBe('settings.codexStorage.errors.SESSION_WRITER_BUSY');
    expect(mocks.nextId).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.filter(([action]) => action === 'clean_ai_storage_orphans')).toHaveLength(0);
  });

  it('reports setup exceptions and permits another cleanup attempt', async () => {
    mocks.nextId.mockImplementationOnce(() => { throw new TypeError('UUID generation unavailable'); });
    const addToast = vi.fn();
    render(<CodexStoragePanel addToast={addToast} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'settings.codexStorage.orphans.confirm' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('settings.codexStorage.errors.STORAGE_OPERATION_FAILED', 'error'));
    expect(screen.getByRole('alert').textContent).toBe('settings.codexStorage.errors.STORAGE_OPERATION_FAILED');
    expect(mocks.request.mock.calls.filter(([action]) => action === 'clean_ai_storage_orphans')).toHaveLength(0);
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'settings.codexStorage.orphans.confirm' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('settings.codexStorage.orphans.cleanedCount · settings.codexStorage.released', 'success'));
  });

  it.each(['DATABASE_BUSY', 'SESSION_RUNNING', 'SESSION_WRITER_BUSY'])('reports a fresh cleanup refusal %s instead of hiding its receipt', async error => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => {
      if (action !== 'clean_ai_storage_orphans') return normal(action, fields);
      const refused: CodexMaintenanceOperation = { ...operation('FAILED_CLEAN'), kind: 'CLEAN_ORPHANED_HISTORY', error };
      operations = [refused];
      return Promise.resolve(refused);
    });
    const addToast = vi.fn();
    render(<CodexStoragePanel addToast={addToast} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'settings.codexStorage.orphans.confirm' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(`settings.codexStorage.errors.${error}`, 'error'));
    expect(screen.getByRole('alert').textContent).toBe(`settings.codexStorage.errors.${error}`);
    await waitFor(() => expect(screen.getByLabelText<HTMLButtonElement>('common.refresh', { selector: 'button' }).disabled).toBe(false));
    expect(screen.getByRole('alert').textContent).toBe(`settings.codexStorage.errors.${error}`);
  });

  it('retains destructive confirmation for positive counts even without candidate details', async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (action: string, fields?: Record<string, unknown>) => {
      const value = await normal(action, fields);
      return action === 'preview_ai_storage_orphans' ? { ...value, candidates: [] } : value;
    });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.orphans.analyze', { selector: 'button' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('settings.codexStorage.orphans.irreversible')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'settings.codexStorage.orphans.confirm' })).toBeTruthy();
    expect(within(dialog).queryByText('settings.codexStorage.orphans.none')).toBeNull();
  });

  it.each(['DELETE_SESSIONS', 'COMPACT_DATABASE', 'CLEAN_ORPHANED_HISTORY'] as const)('does not replay completed %s receipts or notifications on reload', async kind => {
    operations = [{ ...operation(), kind }, { ...operation('FAILED_CLEAN'), operationId: 'older-failure', updatedAt: '2026-10-15T00:00:00Z' }];
    const addToast = vi.fn();
    const view = render(<CodexStoragePanel addToast={addToast} />);
    await screen.findByText('/project/idle');
    await waitFor(() => expect(screen.getByLabelText<HTMLButtonElement>('common.refresh', { selector: 'button' }).disabled).toBe(false));
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    expect(screen.queryByText('settings.codexStorage.rolloutsRemoved')).toBeNull();
    expect(addToast).not.toHaveBeenCalled();
  });

  it.each(['FAILED_CLEAN', 'PARTIAL_COMPLETED', 'COMPLETED_WITH_WARNINGS'])('keeps the latest %s result visible', async state => {
    operations = [operation(state)];
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText(`settings.codexStorage.states.${state}`);
  });

  it('keeps incomplete metadata cleanup visible behind a newer success without displaying zero file bytes', async () => {
    operations = [operation(), { ...operation('COMPLETED_WITH_WARNINGS'), operationId: 'metadata-pending', updatedAt: '2026-10-15T00:00:00Z',
      result: { metadataStatus: 'FAILED', warning: 'METADATA_CLEANUP_FAILED', rolloutBytesRemoved: 0 } }];
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('settings.codexStorage.errors.METADATA_CLEANUP_FAILED');
    expect((screen.getByRole('button', { name: 'settings.codexStorage.continueOperation' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('settings.codexStorage.rolloutsRemoved')).toBeNull();
    expect(screen.queryByText('settings.codexStorage.states.COMPLETED')).toBeNull();
  });

  it.each([
    [4096, 'released', 'success'],
    [0, 'noSavings', 'success'],
    [-1024, 'increased', 'warning'],
  ] as const)('reports measured compaction result %i only through a transient notification', async (releasedBytes, label, toastType) => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (action: string, fields?: Record<string, unknown>) => {
      if (action !== 'compact_ai_storage_database') return normal(action, fields);
      const compacted: CodexMaintenanceOperation = { ...operation(), kind: 'COMPACT_DATABASE', result: { releasedBytes } };
      operations = [compacted];
      return compacted;
    });
    const addToast = vi.fn();
    render(<CodexStoragePanel addToast={addToast} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getByText<HTMLButtonElement>('settings.codexStorage.compact', { selector: 'button' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(`settings.codexStorage.compacted · settings.codexStorage.${label}`, toastType));
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('settings.codexStorage.states.COMPLETED')).toBeNull();
    expect(screen.queryByText(`settings.codexStorage.${label}`)).toBeNull();
  });

  it('keeps pending reconciliation visible even when the last remembered operation is terminal', async () => {
    operations = [operation(), { ...operation('RECONCILIATION_REQUIRED'), operationId: 'pending', kind: 'CLEAN_ORPHANED_HISTORY', targets: ['a'.repeat(64)] }];
    render(<CodexStoragePanel addToast={vi.fn()} />);
    const resume = await screen.findByRole('button', { name: 'settings.codexStorage.continueOperation' });
    expect(within(resume.closest<HTMLElement>('[role="status"]')!).getByText('settings.codexStorage.states.RECONCILIATION_REQUIRED')).toBeTruthy();
    fireEvent.click(resume);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('clean_ai_storage_orphans', expect.objectContaining({
      operationId: 'pending', previewToken: 'a'.repeat(64),
    })));
  });

  it('protects an individually unavailable row and dispatches deletion only after irreversible confirmation', async () => {
    sessionRows[0] = { ...row('unavailable'), deletionUnavailableReason: 'DATABASE_SCHEMA_UNSUPPORTED' };
    const addToast = vi.fn();
    render(<CodexStoragePanel addToast={addToast} />);
    await screen.findByText('/project/idle');
    const rows = screen.getAllByLabelText('common.delete');
    expect((rows[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByLabelText('settings.codexStorage.selectSession')[0] as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(rows[1]!);
    expect(screen.getByText('history.deleteMessage')).toBeTruthy();
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('common.cancel', { selector: 'button' }));
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
    fireEvent.click(rows[1]!);
    fireEvent.click(screen.getByText('common.delete', { selector: 'button' }));
    await waitFor(() => expect(mocks.deleteSessions).toHaveBeenCalledWith(['idle'], operation().operationId));
    expect(screen.queryByText('settings.codexStorage.states.COMPLETED')).toBeNull();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('disables every mutation before admission is known while still allowing session inspection', async () => {
    const normal = mocks.request.getMockImplementation()!;
    let resolveAdmission!: (status: CodexStorageMutationStatus) => void;
    const admission = new Promise<CodexStorageMutationStatus>(resolve => { resolveAdmission = resolve; });
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'get_ai_storage_mutation_status'
      ? admission : normal(action, fields));
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    expect(screen.getByText('settings.codexStorage.checkingAvailability')).toBeTruthy();
    expect(screen.getAllByLabelText('common.delete').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByRole('checkbox').every(checkbox => (checkbox as HTMLInputElement).disabled)).toBe(true);
    expect((screen.getAllByLabelText('settings.codexStorage.view')[1] as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.request.mock.calls.filter(([action]) => action === 'get_ai_storage_mutation_status')).toHaveLength(1);
    await act(async () => { resolveAdmission(storageStatus()); });
    expect(screen.getAllByLabelText('common.delete').every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it.each(['SESSION_RUNNING', 'SESSION_WRITER_BUSY'])('keeps idle deletion available when the %s owner is outside the visible page', async code => {
    sessionRows = multiplePages();
    mutationStatus = storageStatus({ available: false, unavailableReason: code,
      runningSessionIds: code === 'SESSION_RUNNING' ? ['off-page-owner'] : [], writerSessionIds: code === 'SESSION_WRITER_BUSY' ? ['off-page-owner'] : [] });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    expect(screen.getByText(code === 'SESSION_RUNNING' ? 'settings.codexStorage.mutationRunning' : 'settings.codexStorage.mutationWriterBusy')).toBeTruthy();
    expect(screen.getAllByLabelText('common.delete').every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
    const checkboxes = [screen.getByLabelText<HTMLInputElement>('settings.codexStorage.selectVisible'),
      ...screen.getAllByLabelText<HTMLInputElement>('settings.codexStorage.selectSession')];
    expect(checkboxes).toHaveLength(11);
    expect(checkboxes.every(checkbox => !checkbox.disabled)).toBe(true);
    expect(screen.getByText<HTMLButtonElement>('settings.codexStorage.compact', { selector: 'button' }).disabled).toBe(true);
    fireEvent.click(screen.getByTitle('settings.codexStorage.pagination.next'));
    await screen.findByText('/project/next');
    fireEvent.click(screen.getByLabelText('settings.codexStorage.view', { selector: 'button' }));
    await screen.findByText('bounded content', { selector: 'pre' });
    expect(mocks.nextId).not.toHaveBeenCalled();
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
    expect(screen.queryByText('settings.codexStorage.states.FAILED_CLEAN')).toBeNull();
  });

  it('recovers row protection after the owning turn finishes without rescanning session files', async () => {
    sessionRows[1] = row('idle', true);
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_RUNNING', runningSessionIds: ['idle'] });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('settings.codexStorage.mutationRunning');
    await screen.findByText('/project/idle');
    expect((screen.getAllByLabelText('common.delete')[1] as HTMLButtonElement).disabled).toBe(true);
    mutationStatus = storageStatus();
    await waitFor(() => expect((screen.getAllByLabelText('common.delete')[1] as HTMLButtonElement).disabled).toBe(false), { timeout: 3500 });
    expect(mocks.request.mock.calls.filter(([action]) => action === 'list_ai_storage_sessions')).toHaveLength(1);
    expect(screen.queryByText('settings.codexStorage.mutationRunning')).toBeNull();
  });

  it('closes the delete dialog and removes its selection when that target starts in another IDE', async () => {
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByLabelText('settings.codexStorage.selectSession')[1]!);
    fireEvent.click(screen.getAllByLabelText('common.delete')[1]!);
    expect(screen.getByText('history.deleteMessage')).toBeTruthy();
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_RUNNING', runningSessionIds: ['idle'] });
    await screen.findByText('settings.codexStorage.mutationRunning', {}, { timeout: 3500 });
    expect(screen.queryByText('history.deleteMessage')).toBeNull();
    expect(screen.queryByRole('button', { name: 'history.deleteSelected' })).toBeNull();
    expect((screen.getAllByLabelText('settings.codexStorage.selectSession')[1] as HTMLInputElement).checked).toBe(false);
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
  });

  it('rechecks admission before allocating an operation ID or sending an already confirmed deletion', async () => {
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByLabelText('common.delete')[1]!);
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_WRITER_BUSY', writerSessionIds: ['idle'] });
    fireEvent.click(screen.getByText('common.delete', { selector: 'button' }));
    await screen.findByText('settings.codexStorage.mutationWriterBusy');
    expect(mocks.nextId).not.toHaveBeenCalled();
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
  });

  it('preserves an idle target confirmation when a different session becomes busy', async () => {
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByLabelText('common.delete')[1]!);
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_RUNNING', runningSessionIds: ['running'] });
    await screen.findByText('settings.codexStorage.mutationRunning', {}, { timeout: 3500 });
    expect(screen.getByText('history.deleteMessage')).toBeTruthy();
    fireEvent.click(screen.getByText('common.delete', { selector: 'button' }));
    await waitFor(() => expect(mocks.deleteSessions).toHaveBeenCalledWith(['idle'], operation().operationId));
  });

  it('deletes its releasable idle target when a fresh host snapshot clears the old writer protection', async () => {
    sessionRows[1] = { ...row('idle'), deletionUnavailableReason: 'SESSION_WRITER_BUSY' };
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_WRITER_BUSY', writerSessionIds: ['different-ide'] });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    const remove = screen.getAllByLabelText('common.delete')[1] as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    expect((screen.getAllByLabelText('settings.codexStorage.selectSession')[1] as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(remove);
    fireEvent.click(screen.getByText('common.delete', { selector: 'button' }));
    await waitFor(() => expect(mocks.deleteSessions).toHaveBeenCalledWith(['idle'], operation().operationId));
    expect(mocks.request.mock.calls.filter(([action]) => action === 'list_ai_storage_sessions')).toHaveLength(2);
  });

  it('selects only idle targets while distinguishing a native writer from an executing turn', async () => {
    sessionRows = [row('running', true), { ...row('writer'), deletionUnavailableReason: 'SESSION_WRITER_BUSY' }, row('idle')];
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_RUNNING', runningSessionIds: ['running'], writerSessionIds: ['writer'] });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    const checks = screen.getAllByLabelText('settings.codexStorage.selectSession') as HTMLInputElement[];
    expect(checks.map(input => input.disabled)).toEqual([true, true, false]);
    expect(screen.getByText(/settings.codexStorage.running/, { selector: 'small' })).toBeTruthy();
    expect(screen.getByText(/settings.codexStorage.writerBusy/, { selector: 'small' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(checks.map(input => input.checked)).toEqual([false, false, true]);
    fireEvent.click(screen.getByRole('button', { name: 'history.deleteSelected' }));
    fireEvent.click(screen.getByText('common.delete', { selector: 'button' }));
    await waitFor(() => expect(mocks.deleteSessions).toHaveBeenCalledWith(['idle'], operation().operationId));
  });

  it('closes a bulk confirmation when one selected target acquires a native writer lease', async () => {
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'history.deleteSelected' }));
    expect(screen.getByText('history.deleteSelectedMessage')).toBeTruthy();
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_WRITER_BUSY', writerSessionIds: ['idle'] });
    await screen.findByText('settings.codexStorage.mutationWriterBusy', {}, { timeout: 3500 });
    expect(screen.queryByText('history.deleteSelectedMessage')).toBeNull();
    const checks = screen.getAllByLabelText('settings.codexStorage.selectSession') as HTMLInputElement[];
    expect(checks.map(input => input.checked)).toEqual([true, false]);
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
  });

  it('does not submit a partially changed batch when one confirmed target becomes busy before the next poll', async () => {
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'history.deleteSelected' }));
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_RUNNING', runningSessionIds: ['idle'] });
    fireEvent.click(screen.getByText('common.delete', { selector: 'button' }));
    await screen.findByText('settings.codexStorage.mutationRunning');
    expect(mocks.nextId).not.toHaveBeenCalled();
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
  });

  it('clears deletion confirmations for a global safety gate even when no target is running', async () => {
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByLabelText('common.delete')[1]!);
    mutationStatus = storageStatus({ available: false, unavailableReason: 'AI_DATA_MIGRATION_ACTIVE',
      deletionAvailable: false, deletionUnavailableReason: 'AI_DATA_MIGRATION_ACTIVE' });
    await screen.findByText(/settings.codexStorage.deletionUnavailable/, {}, { timeout: 3500 });
    expect(screen.queryByText('history.deleteMessage')).toBeNull();
    expect(screen.getAllByLabelText('common.delete').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
  });

  it('keeps deletion disabled when the host cannot determine admission', async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'get_ai_storage_mutation_status'
      ? Promise.reject(new CodexStorageError('DATABASE_BUSY')) : normal(action, fields));
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    expect(screen.getByText(/settings.codexStorage.deletionUnavailable/)).toBeTruthy();
    expect(screen.getAllByLabelText('common.delete').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(mocks.nextId).not.toHaveBeenCalled();
  });

  it('replaces an old busy-only failure banner with the current admission state', async () => {
    operations = [{ ...operation('FAILED_CLEAN'), error: 'DATABASE_BUSY' }];
    mutationStatus = storageStatus({ available: false, unavailableReason: 'SESSION_WRITER_BUSY' });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('settings.codexStorage.mutationWriterBusy');
    expect(screen.queryByText('settings.codexStorage.states.FAILED_CLEAN')).toBeNull();
  });

  it('loads content only on demand and requests subsequent metadata pages from the host', async () => {
    sessionRows = multiplePages();
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    expect(mocks.request.mock.calls.filter(([action]) => action === 'get_ai_storage_session')).toHaveLength(0);
    expect(mocks.request.mock.calls.filter(([action]) => action === 'list_ai_storage_sessions')).toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledWith('list_ai_storage_sessions', expect.objectContaining({ page: 1, limit: 10 }));
    fireEvent.click(screen.getByTitle('settings.codexStorage.pagination.next'));
    await screen.findByText('/project/next');
    expect(screen.queryByText('/project/idle')).toBeNull();
    expect(mocks.request).toHaveBeenCalledWith('list_ai_storage_sessions', expect.objectContaining({ page: 2, limit: 10 }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.codexStorage.view' }));
    const dialog = await screen.findByRole('dialog', { name: 'settings.codexStorage.sessionContent' });
    await within(dialog).findByText('bounded content', { selector: 'pre' });
    expect(screen.getByRole('region', { name: 'settings.codexStorage.title' }).contains(dialog)).toBe(false);
    expect(screen.getByText(/settings.codexStorage.truncated/)).toBeTruthy();
  });

  it.each([15, 20, 50, 100])('resets to the first page and requests %i sessions per page', async size => {
    const normal = mocks.request.getMockImplementation()!;
    const sessions = Array.from({ length: 125 }, (_, index) => row(`session-${index}`));
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'list_ai_storage_sessions'
      ? Promise.resolve(paginate(sessions, fields)) : normal(action, fields));
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/session-0');
    expect(screen.getAllByLabelText('settings.codexStorage.selectSession')).toHaveLength(10);
    const sizeSelect = screen.getByRole('combobox', { name: 'settings.codexStorage.pagination.pageSize' });
    expect(Array.from((sizeSelect as HTMLSelectElement).options, option => option.value)).toEqual(['10', '15', '20', '50', '100']);
    fireEvent.click(screen.getByTitle('2'));
    await screen.findByText('/project/session-10');
    fireEvent.change(sizeSelect, { target: { value: String(size) } });
    await screen.findByText('/project/session-0');
    expect(screen.getAllByLabelText('settings.codexStorage.selectSession')).toHaveLength(size);
    const listRequests = mocks.request.mock.calls.filter(([action]) => action === 'list_ai_storage_sessions');
    expect(listRequests.at(-1)).toEqual(['list_ai_storage_sessions', expect.objectContaining({ page: 1, limit: size })]);
  });

  it('clears selection and loaded content when moving to another page', async () => {
    sessionRows = multiplePages();
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByLabelText('settings.codexStorage.selectSession')[1]!);
    fireEvent.click(screen.getAllByLabelText('settings.codexStorage.view')[1]!);
    const dialog = await screen.findByRole('dialog', { name: 'settings.codexStorage.sessionContent' });
    await within(dialog).findByText('bounded content', { selector: 'pre' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.codexStorage.close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByTitle('settings.codexStorage.pagination.next'));
    await screen.findByText('/project/next');
    expect(screen.queryByRole('dialog', { name: 'settings.codexStorage.sessionContent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'history.deleteSelected' })).toBeNull();
    expect((screen.getByRole('checkbox', { name: 'settings.codexStorage.selectSession' }) as HTMLInputElement).checked).toBe(false);
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
  });

  it.each([['search', 'textbox', 'needle'], ['sort', 'combobox', 'size'], ['filter', 'combobox', 'idle']])(
    'returns to the first page when %s changes', async (key, role, value) => {
      sessionRows = multiplePages();
      render(<CodexStoragePanel addToast={vi.fn()} />);
      await screen.findByText('/project/idle');
      fireEvent.click(screen.getByTitle('settings.codexStorage.pagination.next'));
      await screen.findByText('/project/next');
      fireEvent.change(screen.getByRole(role, { name: `settings.codexStorage.${key}` }), { target: { value } });
      await screen.findByText('/project/idle');
      expect(screen.queryByText('/project/next')).toBeNull();
      const listRequests = mocks.request.mock.calls.filter(([action]) => action === 'list_ai_storage_sessions');
      expect(listRequests.at(-1)).toEqual(['list_ai_storage_sessions', expect.objectContaining({
        page: 1, limit: 10, [key === 'search' ? 'query' : key]: value,
      })]);
    },
  );

  it('ignores an old page response while a new search is waiting for its debounce', async () => {
    sessionRows = multiplePages();
    const normal = mocks.request.getMockImplementation()!;
    let resolvePage: ((value: ReturnType<typeof paginate>) => void) | undefined;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => {
      if (action !== 'list_ai_storage_sessions') return normal(action, fields);
      if (fields?.page === 2) return new Promise<ReturnType<typeof paginate>>(resolve => { resolvePage = resolve; });
      return fields?.query ? Promise.resolve(paginate([row('filtered')], fields)) : normal(action, fields);
    });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getByTitle('settings.codexStorage.pagination.next'));
    await waitFor(() => expect(resolvePage).toBeDefined());
    fireEvent.change(screen.getByRole('textbox', { name: 'settings.codexStorage.search' }), { target: { value: 'filter' } });
    await act(async () => { resolvePage!({ ...paginate([row('late')]), page: 2 }); });
    expect(screen.queryByText('/project/late')).toBeNull();
    await screen.findByText('/project/filtered');
    expect(screen.queryByText('/project/late')).toBeNull();
  });

  it('adopts the host page after deleting the last session on the final page', async () => {
    const normal = mocks.request.getMockImplementation()!;
    let sessions = [row('idle'), ...Array.from({ length: 9 }, (_, index) => row(`extra-${index}`)), row('last')];
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'list_ai_storage_sessions'
      ? Promise.resolve(paginate(sessions, fields)) : normal(action, fields));
    mocks.deleteSessions.mockImplementation(async () => {
      sessions = sessions.filter(session => session.sessionId !== 'last');
      return { ...operation(), targets: ['last'], result: { deletedSessionIds: ['last'], metadataStatus: 'COMPLETE' } };
    });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getByTitle('settings.codexStorage.pagination.next'));
    await screen.findByText('/project/last');
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'common.delete' }).at(-1)!);
    await screen.findByText('/project/idle');
    expect(screen.queryByText('/project/last')).toBeNull();
    fireEvent.click(screen.getByLabelText<HTMLButtonElement>('common.refresh', { selector: 'button' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('list_ai_storage_sessions', expect.objectContaining({ page: 1, limit: 10 })));
    await screen.findByText('/project/idle');
    const requests = mocks.request.mock.calls.filter(([action]) => action === 'list_ai_storage_sessions');
    expect(requests.at(-1)?.[1]).toMatchObject({ page: 1, limit: 10 });
  });

  it('discovers interrupted work after reload and resumes the same operation and scope', async () => {
    operations = [operation('RECONCILIATION_REQUIRED')];
    render(<CodexStoragePanel addToast={vi.fn()} />);
    const resume = await screen.findByRole('button', { name: 'settings.codexStorage.continueOperation' });
    expect(screen.getByText<HTMLButtonElement>('settings.codexStorage.compact', { selector: 'button' }).disabled).toBe(true);
    fireEvent.click(resume);
    await waitFor(() => expect(mocks.deleteSessions).toHaveBeenCalledWith(['idle'], operation().operationId));
    expect(screen.queryByText('history.deleteMessage')).toBeNull();
  });

  it('makes a returned interrupted operation resumable without leaving the UI permanently busy', async () => {
    mocks.deleteSessions.mockResolvedValue(operation('RECONCILIATION_REQUIRED'));
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByRole('button', { name: 'common.delete' })[1]!);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'common.delete' }).at(-1)!); });
    const resume = screen.getByRole('button', { name: 'settings.codexStorage.continueOperation' });
    expect((resume as HTMLButtonElement).disabled).toBe(false);
    expect(within(resume.closest<HTMLElement>('[role="status"]')!).getByText('settings.codexStorage.states.RECONCILIATION_REQUIRED')).toBeTruthy();
  });

  it('releases the busy state when polling finds reconciliation after a request timeout', async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'get_ai_storage_maintenance_operation'
      ? Promise.resolve(operation('RECONCILIATION_REQUIRED')) : normal(action, fields));
    mocks.deleteSessions.mockRejectedValue(new CodexStorageError('STORAGE_RESPONSE_TIMEOUT'));
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getAllByRole('button', { name: 'common.delete' })[1]!);
      await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'common.delete' }).at(-1)!); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      const resume = screen.getByRole('button', { name: 'settings.codexStorage.continueOperation' });
      expect((resume as HTMLButtonElement).disabled).toBe(false);
      expect(mocks.request).toHaveBeenCalledWith('get_ai_storage_maintenance_operation', { operationId: operation().operationId });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps content errors local and supports previous and next content pages', async () => {
    const normal = mocks.request.getMockImplementation()!;
    let fail = true;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => {
      if (action !== 'get_ai_storage_session') return normal(action, fields);
      if (fail) { fail = false; return Promise.reject(new CodexStorageError('DATABASE_BUSY')); }
      return Promise.resolve({ sessionId: fields?.sessionId, records: [{ text: fields?.cursor ? 'second page' : 'first page', truncated: false }],
        hasMore: !fields?.cursor, nextCursor: fields?.cursor ? undefined : 'db:20' });
    });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByLabelText('settings.codexStorage.view', { selector: 'button' })[1]!);
    const content = screen.getByRole('dialog', { name: 'settings.codexStorage.sessionContent' });
    await within(content).findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(within(content).getByRole('button', { name: 'common.retry' }));
    await within(content).findByText('first page', { selector: 'pre' });
    fireEvent.click(within(content).getByRole('button', { name: 'settings.codexStorage.nextContentPage' }));
    await within(content).findByText('second page', { selector: 'pre' });
    fireEvent.click(within(content).getByRole('button', { name: 'settings.codexStorage.previousContentPage' }));
    await within(content).findByText('first page', { selector: 'pre' });
    expect(document.activeElement).toBe(content.querySelector('section[aria-busy]'));
    // Admission polling can interleave with content requests.
    expect(mocks.request.mock.calls.filter(([action]) => action === 'get_ai_storage_session')).toEqual([
      ['get_ai_storage_session', { sessionId: 'idle', cursor: undefined, limit: 20 }],
      ['get_ai_storage_session', { sessionId: 'idle', cursor: undefined, limit: 20 }],
      ['get_ai_storage_session', { sessionId: 'idle', cursor: 'db:20', limit: 20 }],
      ['get_ai_storage_session', { sessionId: 'idle', cursor: undefined, limit: 20 }],
    ]);
  });

  it('discards an in-flight response after closing and opening another session', async () => {
    const normal = mocks.request.getMockImplementation()!;
    let resolveClosed!: (value: unknown) => void;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => {
      if (action !== 'get_ai_storage_session') return normal(action, fields);
      if (fields?.sessionId === 'idle') return new Promise(resolve => { resolveClosed = resolve; });
      return Promise.resolve({ sessionId: fields?.sessionId, records: [{ text: 'current session content', truncated: false }], hasMore: false });
    });
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByLabelText('settings.codexStorage.view', { selector: 'button' })[1]!);
    const loading = screen.getByRole('dialog', { name: 'settings.codexStorage.sessionContent' });
    expect(within(loading).getByRole('status')).toBeTruthy();
    fireEvent.click(within(loading).getByRole('button', { name: 'settings.codexStorage.close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getAllByLabelText('settings.codexStorage.view', { selector: 'button' })[0]!);
    const current = screen.getByRole('dialog', { name: 'settings.codexStorage.sessionContent' });
    await within(current).findByText('current session content', { selector: 'pre' });
    await act(async () => { resolveClosed({ sessionId: 'idle', records: [{ text: 'stale closed content', truncated: false }], hasMore: false }); });
    expect(within(current).queryByText('stale closed content')).toBeNull();
    expect(within(current).getByText('current session content', { selector: 'pre' })).toBeTruthy();
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
  });

  it('shows empty session content inside the dialog without changing the session list', async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'get_ai_storage_session'
      ? Promise.resolve({ sessionId: fields?.sessionId, records: [], hasMore: false }) : normal(action, fields));
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    fireEvent.click(screen.getAllByLabelText('settings.codexStorage.view', { selector: 'button' })[1]!);
    const dialog = await screen.findByRole('dialog', { name: 'settings.codexStorage.sessionContent' });
    await within(dialog).findByText('settings.codexStorage.noContent');
    expect(within(dialog).queryByRole('button', { name: 'settings.codexStorage.nextContentPage' })).toBeNull();
    expect(screen.getAllByRole('checkbox', { name: 'settings.codexStorage.selectSession' })).toHaveLength(2);
    expect(mocks.request.mock.calls.filter(([action]) => action === 'list_ai_storage_sessions')).toHaveLength(1);
  });

  it('displays measured zero and negative savings accurately', () => {
    expect(storageBytes(0)).toBe('0 B');
    expect(storageBytes(-2048)).toBe('-2.0 KiB');
  });

  it('does not report an empty inventory when session reading fails', async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'list_ai_storage_sessions'
      ? Promise.reject(new CodexStorageError('DATABASE_BUSY')) : normal(action, fields));
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText(/settings.codexStorage.sessionLoadFailed/);
    expect(screen.queryByText('settings.codexStorage.empty')).toBeNull();
    expect(screen.getByRole('heading', { name: 'settings.codexStorage.allSessionsTitle' })).toBeTruthy();
    expect(mocks.deleteSessions).not.toHaveBeenCalled();
  });

  it.each([0, 1])('keeps incomplete coverage distinct from an empty or fully counted inventory (%i readable)', async count => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'list_ai_storage_sessions'
      ? Promise.resolve({ sessions: count ? [{ ...row('readable'), deletionUnavailableReason: 'INVENTORY_INCOMPLETE' }] : [],
        total: count, page: 1, pageSize: 10, hasMore: false, complete: false, errors: ['state_5.sqlite: SQLITE_DRIVER_UNAVAILABLE'] }) : normal(action, fields));
    render(<CodexStoragePanel addToast={vi.fn()} />);
    if (count) {
      await screen.findByRole('heading', { name: 'settings.codexStorage.partialSessions' });
      expect(screen.getByText('settings.codexStorage.incomplete')).toBeTruthy();
      expect((screen.getByRole('button', { name: 'settings.codexStorage.view' }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByRole('button', { name: 'common.delete' }) as HTMLButtonElement).disabled).toBe(true);
    } else {
      await screen.findByRole('alert');
      expect(screen.getByRole('heading', { name: 'settings.codexStorage.allSessionsTitle' })).toBeTruthy();
    }
    expect(screen.queryByText('settings.codexStorage.empty')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'settings.codexStorage.allSessions' })).toBeNull();
    expect(screen.getByText('state_5.sqlite:')).toBeTruthy();
    expect(screen.getByText('settings.codexStorage.errors.SQLITE_DRIVER_UNAVAILABLE')).toBeTruthy();
  });

  it('distinguishes an idle client writer lock from a running turn while keeping its content readable', async () => {
    mutationStatus = storageStatus({ writerSessionIds: ['client-owned'] });
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'list_ai_storage_sessions'
      ? Promise.resolve({ sessions: [{ ...row('client-owned'), deletionUnavailableReason: 'SESSION_WRITER_BUSY' }],
        total: 1, page: 1, pageSize: 10, hasMore: false, complete: true, errors: [] }) : normal(action, fields));
    render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText(/settings\.codexStorage\.writerBusy/);
    expect(screen.queryByText(/settings\.codexStorage\.running/)).toBeNull();
    expect((screen.getByRole('button', { name: 'common.delete' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'settings.codexStorage.view' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows ready database status while an unrelated usage scan is still pending', async () => {
    const normal = mocks.request.getMockImplementation()!;
    let completeUsage: ((value: unknown) => void) | undefined;
    const usage = new Promise(resolve => { completeUsage = resolve; });
    mocks.request.mockImplementation((action: string, fields?: Record<string, unknown>) => action === 'get_ai_storage_usage'
      ? usage : normal(action, fields));
    const view = render(<CodexStoragePanel addToast={vi.fn()} />);
    await screen.findByText('/project/idle');
    await waitFor(() => expect(screen.getByText<HTMLButtonElement>('settings.codexStorage.compact', { selector: 'button' }).disabled).toBe(false));
    view.unmount();
    await act(async () => { completeUsage?.(await normal('get_ai_storage_usage')); });
  });
});
