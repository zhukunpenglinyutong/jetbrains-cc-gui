import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeContentBlock, ClaudeMessage, FileChangeSummary, ToolResultBlock } from '../../types';
import { useFileChanges } from '../../hooks/useFileChanges';
import { useFileChangesManagement } from '../../hooks/useFileChangesManagement';
import { showEditableDiff } from '../../utils/bridge';
import StatusPanel from './StatusPanel';

vi.mock('../../utils/bridge', () => ({
  undoFileChanges: vi.fn(), sendBridgeEvent: vi.fn(), openFile: vi.fn(), showEditableDiff: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const path = '/shared.ts';
function edits(sessionId: string, provider: string, later = false): ClaudeMessage[] {
  return (later ? ['first', 'later'] : ['first']).map((item, index) => ({
    type: 'assistant', raw: { uuid: `${sessionId}-${item}`, message: { content: [{
      type: 'tool_use', id: `${sessionId}-${item}`, name: provider === 'codex' ? 'file_change' : 'Edit',
      input: provider === 'codex'
        ? { status: 'completed', changes: [{ path, kind: 'update', diff: `@@ -1 +1 @@\n-${index ? 'new' : 'old'}\n+${index ? 'later' : 'new'}` }] }
        : { file_path: path, old_string: index ? 'new' : 'old', new_string: index ? 'later' : 'new' },
    }] } },
  }));
}
const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] =>
  typeof message.raw === 'object' && Array.isArray(message.raw.message?.content)
    ? message.raw.message.content.filter((block): block is ClaudeContentBlock => block.type !== 'tool_result') : [];
const findToolResult = (id?: string): ToolResultBlock | null =>
  id ? { type: 'tool_result', tool_use_id: id, content: 'Success' } : null;

function ReviewablePanel({ sessionId, provider, messages }: {
  sessionId: string | null; provider: string; messages: ClaudeMessage[];
}) {
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const fileChangesRef = useRef<FileChangeSummary[]>([]);
  const management = useFileChangesManagement({
    currentSessionId: sessionId, currentSessionIdRef: sessionRef, currentProvider: provider,
    messages, fileChangesRef, getContentBlocks, findToolResult,
  });
  const files = useFileChanges({ messages, currentSessionId: sessionId, getContentBlocks, findToolResult,
    ignoredLedgerKeys: management.ignoredLedgerKeys });
  fileChangesRef.current = files;
  return <StatusPanel todos={[]} subagents={[]} currentProvider={provider} currentSessionId={sessionId}
    fileChanges={files.filter(file => !management.processedFiles.includes(file.filePath))}
    onUndoFile={management.handleUndoFile} />;
}

function openDiff(): string[] {
  fireEvent.click(screen.getByTitle('statusPanel.showDiff'));
  const operations = vi.mocked(showEditableDiff).mock.calls.at(-1)![1] as Array<{ ledgerKey?: string }>;
  const keys = operations.flatMap(operation => operation.ledgerKey ? [operation.ledgerKey] : []);
  expect(keys).not.toHaveLength(0);
  return keys;
}
function receiveReceipt(sessionId: string | null, provider: string, ledgerKeys: string[]) {
  act(() => window.onUndoFileResult?.(JSON.stringify({ success: true, filePath: path, sessionId, provider, ledgerKeys })));
}

describe('Diff rejection receipts retain their original session ledger', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
  afterEach(() => localStorage.clear());

  it('records A after switching to B and restores A without treating the undone operation as reviewable', () => {
    localStorage.setItem('codex-reviewed-edits-A', JSON.stringify(['previously-reviewed-A']));
    localStorage.setItem('codex-reviewed-edits-B', JSON.stringify(['previously-reviewed-B']));
    const a = edits('A', 'codex');
    const b = edits('B', 'codex');
    const { rerender } = render(<ReviewablePanel sessionId="A" provider="codex" messages={a} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    const frozenKeys = openDiff();
    rerender(<ReviewablePanel sessionId="B" provider="codex" messages={b} />);
    receiveReceipt('A', 'codex', frozenKeys);
    expect(screen.getByTitle('statusPanel.undoChanges')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('codex-reviewed-edits-B') ?? '[]')).toEqual(['previously-reviewed-B']);
    expect(JSON.parse(localStorage.getItem('codex-reviewed-edits-A') ?? '[]')).toEqual(['previously-reviewed-A', ...frozenKeys]);
    rerender(<ReviewablePanel sessionId="A" provider="codex" messages={a} />);
    expect(screen.queryByTitle('statusPanel.undoChanges')).toBeNull();
    rerender(<ReviewablePanel sessionId="A" provider="codex" messages={edits('A', 'codex', true)} />);
    const laterKeys = openDiff();
    expect(laterKeys).toHaveLength(1);
    expect(laterKeys).not.toContain(frozenKeys[0]);
  });

  it('reviews only the frozen Diff keys when another edit arrives in the same session', () => {
    const { rerender } = render(<ReviewablePanel sessionId="A" provider="codex" messages={edits('A', 'codex')} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    const frozenKeys = openDiff();
    rerender(<ReviewablePanel sessionId="A" provider="codex" messages={edits('A', 'codex', true)} />);
    receiveReceipt('A', 'codex', frozenKeys);
    expect(screen.getByTitle('statusPanel.undoChanges')).toBeTruthy();
    const laterKeys = openDiff();
    expect(laterKeys).toHaveLength(1);
    expect(laterKeys).not.toContain(frozenKeys[0]);
    expect(JSON.parse(localStorage.getItem('codex-reviewed-edits-A') ?? '[]')).toEqual(frozenKeys);
  });

  it('does not consume B pending undo when A Diff returns for the same path', () => {
    const { rerender } = render(<ReviewablePanel sessionId="A" provider="codex" messages={edits('A', 'codex')} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    const aKeys = openDiff();
    rerender(<ReviewablePanel sessionId="B" provider="codex" messages={edits('B', 'codex')} />);
    const bKeys = openDiff();
    fireEvent.click(screen.getByTitle('statusPanel.undoChanges'));
    fireEvent.click(screen.getByText('statusPanel.confirmUndo'));
    expect((screen.getByTitle('statusPanel.undoChanges') as HTMLButtonElement).disabled).toBe(true);
    receiveReceipt('A', 'codex', aKeys);
    expect((screen.getByTitle('statusPanel.undoChanges') as HTMLButtonElement).disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem('codex-reviewed-edits-A') ?? '[]')).toEqual(aKeys);
    expect(localStorage.getItem('codex-reviewed-edits-B')).toBeNull();
    act(() => window.onUndoFileResult?.(JSON.stringify({ success: true, filePath: path })));
    expect(screen.queryByTitle('statusPanel.undoChanges')).toBeNull();
    expect(JSON.parse(localStorage.getItem('codex-reviewed-edits-B') ?? '[]')).toEqual(bKeys);
  });

  it('keeps B pending and both ledgers untouched when A reports a failed Diff rejection', () => {
    const { rerender } = render(<ReviewablePanel sessionId="A" provider="codex" messages={edits('A', 'codex')} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    const aKeys = openDiff();
    rerender(<ReviewablePanel sessionId="B" provider="codex" messages={edits('B', 'codex')} />);
    fireEvent.click(screen.getByTitle('statusPanel.undoChanges'));
    fireEvent.click(screen.getByText('statusPanel.confirmUndo'));
    act(() => window.onUndoFileResult?.(JSON.stringify({ success: false, filePath: path,
      sessionId: 'A', provider: 'codex', ledgerKeys: aKeys, error: 'The file has changed since the Diff opened' })));
    expect((screen.getByTitle('statusPanel.undoChanges') as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem('codex-reviewed-edits-A')).toBeNull();
    expect(localStorage.getItem('codex-reviewed-edits-B')).toBeNull();
  });

  it.each([['codex', 'claude'], ['claude', 'codex']])('uses original %s storage while the current provider is %s', (aProvider, bProvider) => {
    const a = edits('A', aProvider);
    const b = edits('B', bProvider);
    const { rerender } = render(<ReviewablePanel sessionId="A" provider={aProvider} messages={a} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    const keys = openDiff();
    rerender(<ReviewablePanel sessionId="B" provider={bProvider} messages={b} />);
    receiveReceipt('A', aProvider, keys);
    expect(screen.getByTitle('statusPanel.undoChanges')).toBeTruthy();
    expect(localStorage.getItem('codex-reviewed-edits-B')).toBeNull();
    expect(localStorage.getItem('processed-files-B')).toBeNull();
    const stored = localStorage.getItem(aProvider === 'codex' ? 'codex-reviewed-edits-A' : 'processed-files-A');
    expect(JSON.parse(stored ?? '[]')).toEqual(aProvider === 'codex' ? keys : [path]);
    rerender(<ReviewablePanel sessionId="A" provider={aProvider} messages={a} />);
    expect(screen.queryByTitle('statusPanel.undoChanges')).toBeNull();
  });

  it('keeps an explicit anonymous Diff origin from marking an established session', () => {
    const { rerender } = render(<ReviewablePanel sessionId={null} provider="codex" messages={edits('anonymous', 'codex')} />);
    fireEvent.click(screen.getByText('statusPanel.editsTab'));
    const keys = openDiff();
    rerender(<ReviewablePanel sessionId="B" provider="codex" messages={edits('B', 'codex')} />);
    receiveReceipt(null, 'codex', keys);
    expect(screen.getByTitle('statusPanel.undoChanges')).toBeTruthy();
    expect(localStorage.getItem('codex-reviewed-edits-B')).toBeNull();
    expect(localStorage.getItem('codex-reviewed-edits-null')).toBeNull();
  });
});
