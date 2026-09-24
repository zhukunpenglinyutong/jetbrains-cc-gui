import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiDataStorageSection from './index';

const mocks = vi.hoisted(() => ({
  statusListeners: [] as Array<(status: unknown) => void>,
  rootListeners: [] as Array<(path: string) => void>,
  operationListeners: [] as Array<(operation: unknown) => void>,
  getStatus: vi.fn(),
  chooseRoot: vi.fn(),
  migrate: vi.fn(),
  cleanupBackups: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));

vi.mock('./aiDataStorageBridge', () => ({
  aiDataStorageBridge: {
    subscribeStatus: (listener: (status: unknown) => void) => {
      mocks.statusListeners.push(listener);
      return () => undefined;
    },
    subscribeRoot: (listener: (path: string) => void) => {
      mocks.rootListeners.push(listener);
      return () => undefined;
    },
    subscribeOperation: (listener: (operation: unknown) => void) => {
      mocks.operationListeners.push(listener);
      return () => undefined;
    },
    getStatus: mocks.getStatus,
    chooseRoot: mocks.chooseRoot,
    migrate: mocks.migrate,
    cleanupBackups: mocks.cleanupBackups,
  },
}));

const status = {
  platform: 'windows',
  supported: true,
  wsl: false,
  homeDirectory: 'C:/Users/test',
  recovered: false,
  backupCount: 1,
  directories: [
    { id: 'claude', canonicalPath: 'C:/Users/test/.claude', state: 'local' },
    { id: 'codemoss', canonicalPath: 'C:/Users/test/.codemoss', state: 'local' },
    { id: 'codex', canonicalPath: 'C:/Users/test/.codex', state: 'local' },
  ],
  backups: [{ id: 'codex', path: 'C:/Users/test/.codex.cc-gui-backup-1' }],
};

describe('AiDataStorageSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.statusListeners.length = 0;
    mocks.rootListeners.length = 0;
    mocks.operationListeners.length = 0;
    mocks.getStatus.mockClear();
    mocks.chooseRoot.mockClear();
    mocks.migrate.mockClear();
    mocks.cleanupBackups.mockClear();
    mocks.getStatus.mockReturnValue(true);
    mocks.chooseRoot.mockReturnValue(true);
    mocks.migrate.mockReturnValue(true);
    mocks.cleanupBackups.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows all canonical directories and requests status on mount', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!(status));

    expect(mocks.getStatus).toHaveBeenCalledOnce();
    expect(screen.getByText('.claude')).toBeTruthy();
    expect(screen.getByText('.codemoss')).toBeTruthy();
    expect(screen.getByText('.codex')).toBeTruthy();
  });

  it('disables relocation controls on unsupported platforms', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!({
      ...status,
      platform: 'macos',
      supported: false,
    }));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));

    expect(screen.getByText('settings.storage.windowsOnly')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'settings.storage.chooseRoot' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: 'settings.storage.migrate' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: 'settings.storage.cleanupBackups' }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.cleanupBackups' }));
    expect(mocks.cleanupBackups).not.toHaveBeenCalled();
  });

  it('requires confirmation before migration', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!(status));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(screen.getByText('settings.storage.migrateConfirmTitle')).toBeTruthy();
    expect(screen.getByText('D:/AI Data')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));

    expect(mocks.migrate).toHaveBeenCalledWith('D:/AI Data', expect.any(String));
  });

  it('requires confirmation before deleting migration backups', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!(status));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.cleanupBackups' }));
    expect(mocks.cleanupBackups).not.toHaveBeenCalled();
    expect(screen.getByText('settings.storage.cleanupConfirmTitle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.deleteBackups' }));

    expect(mocks.cleanupBackups).toHaveBeenCalledWith(expect.any(String));
  });

  it('clears migration pending state when the bridge is unavailable', () => {
    const addToast = vi.fn();
    vi.useFakeTimers();
    mocks.migrate.mockReturnValue(false);
    render(<AiDataStorageSection addToast={addToast} />);
    act(() => mocks.statusListeners[0]!(status));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));

    expect(addToast).toHaveBeenCalledWith('settings.storage.operationFailed', 'error');
    expect((screen.getByRole('button', { name: 'settings.storage.migrate' }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(120_000));
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it('clears cleanup pending state when the bridge is unavailable', () => {
    const addToast = vi.fn();
    mocks.cleanupBackups.mockReturnValue(false);
    render(<AiDataStorageSection addToast={addToast} />);
    act(() => mocks.statusListeners[0]!(status));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.cleanupBackups' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.deleteBackups' }));

    expect(addToast).toHaveBeenCalledWith('settings.storage.operationFailed', 'error');
    expect((screen.getByRole('button', { name: 'settings.storage.cleanupBackups' }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it('clears the operation timeout when a matching failure callback arrives', () => {
    const addToast = vi.fn();
    vi.useFakeTimers();
    render(<AiDataStorageSection addToast={addToast} />);
    act(() => mocks.statusListeners[0]!(status));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));
    const requestId = mocks.migrate.mock.calls[0]![1] as string;
    act(() => mocks.operationListeners[0]!({
      operation: 'migrate',
      requestId,
      success: false,
      error: 'TARGET_ROOT_REQUIRED',
    }));

    expect(addToast).toHaveBeenCalledWith('settings.storage.errors.targetRootRequired', 'error');
    act(() => vi.advanceTimersByTime(120_000));
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it('keeps the active operation timeout when an unrelated callback arrives', () => {
    const addToast = vi.fn();
    vi.useFakeTimers();
    render(<AiDataStorageSection addToast={addToast} />);
    act(() => mocks.statusListeners[0]!(status));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));
    const requestId = mocks.migrate.mock.calls[0]![1] as string;
    act(() => mocks.operationListeners[0]!({ operation: 'cleanup', requestId, success: true }));

    act(() => vi.advanceTimersByTime(120_000));
    expect(addToast).toHaveBeenCalledWith('settings.storage.operationTimeout', 'error');
  });

  it('ignores a delayed callback from an earlier request of the same operation', () => {
    const addToast = vi.fn();
    vi.useFakeTimers();
    render(<AiDataStorageSection addToast={addToast} />);
    act(() => mocks.statusListeners[0]!(status));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));
    const firstRequestId = mocks.migrate.mock.calls[0]![1] as string;
    act(() => vi.advanceTimersByTime(120_000));
    addToast.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));
    const secondRequestId = mocks.migrate.mock.calls[1]![1] as string;
    act(() => mocks.operationListeners[0]!({
      operation: 'migrate', requestId: firstRequestId, success: true,
    }));

    expect(addToast).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'settings.storage.migrating' }) as HTMLButtonElement).disabled)
      .toBe(true);

    act(() => mocks.operationListeners[0]!({
      operation: 'migrate', requestId: secondRequestId, success: true,
    }));
    expect(addToast).toHaveBeenCalledWith('settings.storage.migrateSuccess', 'success');
  });

  it('keeps an active operation tracked when the toast callback changes', () => {
    const firstAddToast = vi.fn();
    const secondAddToast = vi.fn();
    const view = render(<AiDataStorageSection addToast={firstAddToast} />);
    act(() => mocks.statusListeners[0]!(status));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));
    const requestId = mocks.migrate.mock.calls[0]![1] as string;
    view.rerender(<AiDataStorageSection addToast={secondAddToast} />);
    act(() => mocks.operationListeners[0]!({
      operation: 'migrate', requestId, success: true,
    }));

    expect(firstAddToast).not.toHaveBeenCalled();
    expect(secondAddToast).toHaveBeenCalledWith('settings.storage.migrateSuccess', 'success');
    expect((screen.getByRole('button', { name: 'settings.storage.migrate' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('keeps the active timeout when the toast callback changes', () => {
    const firstAddToast = vi.fn();
    const secondAddToast = vi.fn();
    vi.useFakeTimers();
    const view = render(<AiDataStorageSection addToast={firstAddToast} />);
    act(() => mocks.statusListeners[0]!(status));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));
    view.rerender(<AiDataStorageSection addToast={secondAddToast} />);
    act(() => vi.advanceTimersByTime(120_000));

    expect(firstAddToast).not.toHaveBeenCalled();
    expect(secondAddToast).toHaveBeenCalledWith('settings.storage.operationTimeout', 'error');
    expect((screen.getByRole('button', { name: 'settings.storage.migrate' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('refreshes status from the directory list header', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    mocks.getStatus.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));

    expect(mocks.getStatus).toHaveBeenCalledOnce();
  });

  it('does not show an error toast for a failed status refresh', () => {
    const addToast = vi.fn();
    render(<AiDataStorageSection addToast={addToast} />);

    act(() => mocks.operationListeners[0]!({
      operation: 'status',
      success: false,
      error: 'TARGET_ROOT_UNAVAILABLE',
    }));

    expect(addToast).not.toHaveBeenCalled();
  });

  it('maps backend error codes to localized messages', () => {
    const addToast = vi.fn();
    render(<AiDataStorageSection addToast={addToast} />);
    act(() => mocks.statusListeners[0]!(status));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));
    const requestId = mocks.migrate.mock.calls[0]![1] as string;

    act(() => mocks.operationListeners[0]!({
      operation: 'migrate',
      requestId,
      success: false,
      error: 'TARGET_ROOT_REQUIRED',
    }));

    expect(addToast).toHaveBeenCalledWith('settings.storage.errors.targetRootRequired', 'error');
  });

  it('prevents repeating migration when the current storage root is selected', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!({
      ...status,
      storageRoot: 'D:\\AI Data',
      directories: status.directories.map((entry) => ({
        ...entry,
        physicalPath: `D:/AI Data/.${entry.id}`,
        state: 'linked',
      })),
    }));

    const migrateButton = screen.getByRole('button', { name: 'settings.storage.alreadyMigrated' });
    expect((migrateButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('prevents repeating migration for a partially linked current storage root', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!({
      ...status,
      storageRoot: 'D:/AI Data',
      directories: status.directories.map((entry, index) => ({
        ...entry,
        physicalPath: index === 0 ? `D:/AI Data/.${entry.id}` : undefined,
        state: index === 0 ? 'linked' : 'local',
      })),
    }));

    const migrateButton = screen.getByRole('button', { name: 'settings.storage.alreadyMigrated' });
    expect((migrateButton as HTMLButtonElement).disabled).toBe(true);
  });
});
