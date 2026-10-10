import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StatusPanel from './StatusPanel';
import { undoFileChanges, sendBridgeEvent } from '../../utils/bridge';

vi.mock('../../utils/bridge', () => ({ undoFileChanges: vi.fn(), sendBridgeEvent: vi.fn(), openFile: vi.fn(), showEditableDiff: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('StatusPanel', () => {
  beforeEach(() => vi.clearAllMocks());
  const file = (key: string, path = '/one.ts') => ({ filePath: path, fileName: path, status: 'M' as const, additions: 1, deletions: 1,
    operations: [{ toolName: 'edit', oldString: 'old', newString: 'new', additions: 1, deletions: 1, ledgerKey: key, fileChangeKind: 'update' as const }] });

  it('matches each concurrently undone file with its submitted ledger keys', () => {
    const onUndoFile = vi.fn();
    render(<StatusPanel todos={[]} subagents={[]} currentProvider="codex" currentSessionId="session"
      onUndoFile={onUndoFile} fileChanges={[file('first'), file('second', '/two.ts')]} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    fireEvent.click(screen.getAllByTitle('statusPanel.undoChanges')[0]);
    fireEvent.click(screen.getByText('statusPanel.confirmUndo'));
    fireEvent.click(screen.getAllByTitle('statusPanel.undoChanges')[1]);
    fireEvent.click(screen.getByText('statusPanel.confirmUndo'));
    expect(screen.getAllByTitle('statusPanel.undoChanges').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect((screen.getByTitle('statusPanel.discardAll') as HTMLButtonElement).disabled).toBe(true);
    act(() => window.onUndoFileResult?.(JSON.stringify({ success: true, filePath: '/one.ts' })));
    expect(onUndoFile).toHaveBeenLastCalledWith('/one.ts', ['first']);
    expect((screen.getAllByTitle('statusPanel.undoChanges')[1] as HTMLButtonElement).disabled).toBe(true);
    act(() => window.onUndoFileResult?.(JSON.stringify({ success: true, filePath: '/two.ts' })));
    expect(onUndoFile).toHaveBeenLastCalledWith('/two.ts', ['second']);
  });

  it('releases single and batch undo waiting states when dispatch fails', () => {
    vi.mocked(undoFileChanges).mockReturnValueOnce(false);
    vi.mocked(sendBridgeEvent).mockReturnValueOnce(false);
    render(<StatusPanel todos={[]} subagents={[]} currentProvider="codex" fileChanges={[file('first')]} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    fireEvent.click(screen.getByTitle('statusPanel.undoChanges'));
    fireEvent.click(screen.getByText('statusPanel.confirmUndo'));
    expect((screen.getByTitle('statusPanel.undoChanges') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTitle('statusPanel.discardAll'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect((screen.getByTitle('statusPanel.discardAll') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTitle('statusPanel.undoChanges') as HTMLButtonElement).disabled).toBe(false);
  });
  it('reviews only the submitted undo keys when the conversation advances', () => {
    const onUndoFile = vi.fn();
    const props = { todos: [], subagents: [], currentProvider: 'codex', currentSessionId: 'same-session', onUndoFile, fileChanges: [file('first')] };
    const { rerender } = render(<StatusPanel {...props} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    fireEvent.click(screen.getByTitle('statusPanel.undoChanges'));
    fireEvent.click(screen.getByText('statusPanel.confirmUndo'));
    rerender(<StatusPanel {...props} fileChanges={[file('next')]} />);
    act(() => window.onUndoFileResult?.(JSON.stringify({ success: true, filePath: '/one.ts' })));
    expect(onUndoFile).toHaveBeenCalledWith('/one.ts', ['first']);
  });

  it('keeps failed batch files reviewable and isolates a late result after switching sessions', () => {
    const onUndoFile = vi.fn();
    const onDiscardAll = vi.fn();
    const props = { todos: [], subagents: [], currentProvider: 'codex', currentSessionId: 'session', onUndoFile, onDiscardAll,
      fileChanges: [file('first'), file('second', '/two.ts')] };
    const { rerender } = render(<StatusPanel {...props} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    fireEvent.click(screen.getByTitle('statusPanel.discardAll'));
    fireEvent.click(screen.getByText('common.confirm'));
    expect(sendBridgeEvent).toHaveBeenCalledWith('undo_all_file_changes', JSON.stringify({ files: props.fileChanges.map(({ filePath, status, operations }) => ({ filePath, status, operations })) }));
    act(() => window.onUndoAllFileResult?.(JSON.stringify({ success: false, successfulFiles: ['/one.ts'], error: 'two failed' })));
    expect(onUndoFile).toHaveBeenCalledWith('/one.ts', ['first']);
    expect(onDiscardAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('statusPanel.discardAll'));
    fireEvent.click(screen.getByText('common.confirm'));
    rerender(<StatusPanel {...props} currentSessionId="another" />);
    act(() => window.onUndoAllFileResult?.(JSON.stringify({ success: true })));
    expect(onUndoFile).toHaveBeenNthCalledWith(2, '/one.ts', ['first'], { sessionId: 'session', provider: 'codex' });
    expect(onUndoFile).toHaveBeenNthCalledWith(3, '/two.ts', ['second'], { sessionId: 'session', provider: 'codex' });
  });
  it('retains native undo metadata and only removes successfully restored files', () => {
    const onUndoFile = vi.fn();
    const onDiscardAll = vi.fn();
    const operations = [{ toolName: 'edit', oldString: 'old', newString: 'new', additions: 1, deletions: 1,
      fileChangeKind: 'update' as const, patch: '@@ -1 +1 @@\n-old\n+new', moveFrom: '/old.ts' }];
    render(<StatusPanel todos={[]} subagents={[]} currentProvider="codex" onUndoFile={onUndoFile} onDiscardAll={onDiscardAll}
      fileChanges={[{ filePath: '/moved.ts', fileName: 'moved.ts', status: 'R', additions: 1, deletions: 1, operations }]} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    fireEvent.click(screen.getByTitle('statusPanel.undoChanges'));
    fireEvent.click(screen.getByText('statusPanel.confirmUndo'));
    expect(undoFileChanges).toHaveBeenCalledWith('/moved.ts', 'R', operations);
    act(() => window.onUndoAllFileResult?.(JSON.stringify({ success: false, successfulFiles: ['/moved.ts'], error: 'other file failed' })));
    expect(onDiscardAll).not.toHaveBeenCalled();
    expect(onUndoFile).toHaveBeenCalledWith('/moved.ts');
  });
  it.each([
    ['codex', 'statusPanel.todoTab'],
    ['claude', 'statusPanel.tasksTab'],
  ])('uses the provider-specific todo label for %s', (currentProvider, expectedLabel) => {
    render(
      <StatusPanel
        todos={[]}
        fileChanges={[]}
        subagents={[]}
        currentProvider={currentProvider}
      />,
    );

    expect(screen.getByText(expectedLabel)).toBeTruthy();
  });
});
