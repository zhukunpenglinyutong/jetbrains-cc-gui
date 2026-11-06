import { act, renderHook } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
import { useFileChangesManagement } from './useFileChangesManagement.js';
import { useFileChanges } from './useFileChanges';
import type { ClaudeContentBlock, ClaudeMessage, FileChangeSummary, ToolInput, ToolResultBlock } from '../types';

function makeMessages(count: number): ClaudeMessage[] {
  return Array.from({ length: count }, () => ({ raw: { role: 'assistant', content: [] } }) as unknown as ClaudeMessage);
}

function makeOptions(messages: ClaudeMessage[], sessionId: string | null) {
  const currentSessionIdRef: RefObject<string | null> = { current: sessionId };
  return {
    currentSessionId: sessionId,
    currentSessionIdRef,
    messages,
    getContentBlocks: () => [],
    findToolResult: () => null,
  };
}

function readStored(sessionId: string): string[] | null {
  const raw = localStorage.getItem(`confirmed-edits-${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

describe('useFileChangesManagement > confirmEdits (Keep All)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('acknowledges operations and persists them for the session', () => {
    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-1'),
    });

    act(() => {
      result.current.confirmEdits(['op-a', 'op-b']);
    });

    expect([...result.current.confirmedEditKeys].sort()).toEqual(['op-a', 'op-b']);
    expect(readStored('session-1')?.slice().sort()).toEqual(['op-a', 'op-b']);
  });

  it('accumulates across calls without duplicating', () => {
    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-1'),
    });

    act(() => {
      result.current.confirmEdits(['op-a']);
    });
    act(() => {
      result.current.confirmEdits(['op-a', 'op-b']);
    });

    expect([...result.current.confirmedEditKeys].sort()).toEqual(['op-a', 'op-b']);
    expect(readStored('session-1')?.slice().sort()).toEqual(['op-a', 'op-b']);
  });

  // The reported regression, end to end: Keep All in one session, start a new
  // session, then reopen the first one from history — nothing kept may return.
  it('restores the acknowledgements when the session is reopened', () => {
    const { result: first } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-A'),
    });

    act(() => {
      first.current.confirmEdits(['op-a']);
    });

    const { result: other } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-B'),
    });
    expect(other.current.confirmedEditKeys.size).toBe(0);

    const { result: reopened } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-A'),
    });
    expect([...reopened.current.confirmedEditKeys]).toEqual(['op-a']);
  });

  it('clears the acknowledgements when switching to a session that has none', () => {
    const { result, rerender } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-A'),
    });

    act(() => {
      result.current.confirmEdits(['op-a']);
    });
    expect(result.current.confirmedEditKeys.size).toBe(1);

    rerender(makeOptions([], 'session-B'));

    expect(result.current.confirmedEditKeys.size).toBe(0);
  });

  it('clears the persisted per-file marks along with the acknowledgements', () => {
    // A file the user accepted one by one earlier must not come back after Keep
    // All: on the next load it would hide later edits to that same file, and the
    // list would no longer offer a way to undo it.
    localStorage.setItem('processed-files-session-1', '["/proj/x.ts"]');

    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-1'),
    });
    act(() => {
      result.current.confirmEdits(['op-a']);
    });

    expect(localStorage.getItem('processed-files-session-1')).toBeNull();
    expect(readStored('session-1')).toEqual(['op-a']);
  });

  it('clears the persisted per-file marks even when there is nothing new to acknowledge', () => {
    localStorage.setItem('processed-files-session-1', '["/proj/x.ts"]');

    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-1'),
    });
    act(() => {
      result.current.confirmEdits([]);
    });

    expect(localStorage.getItem('processed-files-session-1')).toBeNull();
  });

  it('flushes the acknowledgements once the session id arrives', () => {
    const messages = makeMessages(2);
    const { result, rerender } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions(messages, null),
    });

    // A brand-new session has no id until the backend reports one.
    act(() => {
      result.current.confirmEdits(['op-a']);
    });
    expect(readStored('session-late')).toBeNull();
    // The in-memory effect is immediate regardless.
    expect(result.current.confirmedEditKeys.size).toBe(1);

    // window.setSessionId updates both the ref and the state; the transcript is
    // left alone, and that is what marks the id as belonging to this session.
    const adopted = makeOptions(messages, 'session-late');
    adopted.currentSessionIdRef.current = 'session-late';
    rerender(adopted);

    expect(readStored('session-late')).toEqual(['op-a']);
    expect([...result.current.confirmedEditKeys]).toEqual(['op-a']);
  });

  // Switching to another existing session also goes from "no id" to "an id", so
  // a pending acknowledgement must not be flushed onto — and overwrite — that
  // session's own record.
  it('does not flush a pending acknowledgement onto a different session', () => {
    const { result, rerender } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions(makeMessages(2), null),
    });

    act(() => {
      result.current.confirmEdits(['op-a']);
    });

    // The other session already has its own acknowledgements.
    localStorage.setItem('confirmed-edits-session-B', '["op-b"]');
    // Switching empties the transcript first, so the pending list has nothing
    // to be recognised by and is dropped.
    const switched = makeOptions([], 'session-B');
    switched.currentSessionIdRef.current = 'session-B';
    rerender(switched);

    expect(readStored('session-B')).toEqual(['op-b']);
    expect([...result.current.confirmedEditKeys]).toEqual(['op-b']);
  });

  it('ignores a malformed persisted list', () => {
    localStorage.setItem('confirmed-edits-session-1', '{"not":"a list"}');

    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-1'),
    });

    expect(result.current.confirmedEditKeys.size).toBe(0);
  });

  it('drops superseded position-based baselines from earlier releases', () => {
    localStorage.setItem('keep-all-base-session-1', '3');
    localStorage.setItem('keep-all-anchor-session-1', '{"aliases":[],"index":0}');

    renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions([], 'session-1'),
    });

    expect(localStorage.getItem('keep-all-base-session-1')).toBeNull();
    expect(localStorage.getItem('keep-all-anchor-session-1')).toBeNull();
  });
});

describe('Codex review checkpoints', () => {
  afterEach(() => localStorage.clear());

  it.each(['keep', 'undo', 'discard'])('checkpoints legacy edits together with native patches after %s', action => {
    const tool = (id: string, name: string, input: ToolInput): ClaudeMessage => ({
      type: 'assistant', raw: { message: { content: [{ type: 'tool_use', id, name, input }] } },
    });
    const messages = [
      tool('native', 'file_change', { status: 'completed', changes: [{ path: '/native.ts', kind: 'add', diff: '+native' }] }),
      tool('legacy', 'Edit', { file_path: '/legacy.ts', old_string: 'before', new_string: 'after' }),
    ];
    const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] =>
      typeof message.raw === 'object' && Array.isArray(message.raw.message?.content)
        ? message.raw.message.content.filter((block): block is ClaudeContentBlock => block.type !== 'tool_result') : [];
    const findToolResult = (id?: string): ToolResultBlock | null => id?.startsWith('legacy')
      ? { type: 'tool_result', tool_use_id: id, content: 'Success' } : null;
    const useReviewableEdits = (currentMessages: ClaudeMessage[]) => {
      const fileChangesRef = useRef<FileChangeSummary[]>([]);
      const management = useFileChangesManagement({ ...makeOptions(currentMessages, 'mixed-codex'),
        currentProvider: 'codex', fileChangesRef });
      const files = useFileChanges({ messages: currentMessages, currentSessionId: 'mixed-codex',
        getContentBlocks, findToolResult, ignoredLedgerKeys: management.ignoredLedgerKeys });
      fileChangesRef.current = files;
      return { ...management, files };
    };
    const { result, rerender, unmount } = renderHook(useReviewableEdits, { initialProps: messages });
    expect(result.current.files.map(file => file.filePath).sort()).toEqual(['/legacy.ts', '/native.ts']);
    act(() => {
      if (action === 'keep') result.current.handleKeepAll();
      else if (action === 'discard') result.current.handleDiscardAll(result.current.files);
      else for (const file of result.current.files) result.current.handleUndoFile(file.filePath);
    });
    expect(result.current.files).toEqual([]);
    const laterMessages = [...messages,
      tool('legacy-later', 'Edit', { file_path: '/legacy.ts', old_string: 'after', new_string: 'next' })];
    rerender(laterMessages);
    expect(result.current.files).toMatchObject([{ filePath: '/legacy.ts', operations: [{ newString: 'next' }] }]);
    unmount();
    const restored = renderHook(useReviewableEdits, { initialProps: laterMessages });
    expect(restored.result.current.files).toMatchObject([{ filePath: '/legacy.ts', operations: [{ newString: 'next' }] }]);
  });

  it('remembers reviewed operations rather than hiding all future edits of a path', () => {
    const fileChangesRef = { current: [{ filePath: '/one.ts', operations: [{ ledgerKey: 'first' }] },
      { filePath: '/two.ts', operations: [{ ledgerKey: 'second' }] }] };
    const options = { ...makeOptions(makeMessages(2), 'native-session'), currentProvider: 'codex', fileChangesRef };
    const { result, unmount } = renderHook(() => useFileChangesManagement(options));
    act(() => result.current.handleUndoFile('/one.ts'));
    expect(result.current.processedFiles).toEqual([]);
    expect(result.current.ignoredLedgerKeys).toEqual(['first']);
    fileChangesRef.current = [{ filePath: '/one.ts', operations: [{ ledgerKey: 'next' }] },
      { filePath: '/two.ts', operations: [{ ledgerKey: 'second' }] }];
    act(() => result.current.handleKeepAll());
    expect(result.current.ignoredLedgerKeys).toEqual(['first', 'next', 'second']);
    unmount();
    const restored = renderHook(() => useFileChangesManagement(options));
    expect(restored.result.current.ignoredLedgerKeys).toEqual(['first', 'next', 'second']);
  });

  it('checkpoints the submitted operations if new edits arrive before the undo result', () => {
    const fileChangesRef = { current: [{ filePath: '/one.ts', operations: [{ ledgerKey: 'new-edit' }] }] };
    const { result } = renderHook(() => useFileChangesManagement({ ...makeOptions([], 'native'), currentProvider: 'codex', fileChangesRef }));
    act(() => result.current.handleUndoFile('/one.ts', ['old-edit']));
    expect(result.current.ignoredLedgerKeys).toEqual(['old-edit']);
    act(() => window.handleDiffResult?.(JSON.stringify({ filePath: '/one.ts', action: 'APPLY' })));
    expect(result.current.ignoredLedgerKeys).toEqual(['old-edit', 'new-edit']);
    act(() => result.current.handleDiscardAll([{ filePath: '/two.ts', operations: [{ ledgerKey: 'two' }] }]));
    expect(result.current.ignoredLedgerKeys).toContain('two');
  });

  it('does not hide edits when a saved checkpoint is malformed or belongs to another session', () => {
    localStorage.setItem('codex-reviewed-edits-native', '{broken');
    const { result, rerender } = renderHook(props => useFileChangesManagement(props), {
      initialProps: { ...makeOptions([], 'native'), currentProvider: 'codex' },
    });
    expect(result.current.ignoredLedgerKeys).toEqual([]);
    localStorage.setItem('codex-reviewed-edits-other', '[42]');
    rerender({ ...makeOptions([], 'other'), currentProvider: 'codex' });
    expect(result.current.ignoredLedgerKeys).toEqual([]);
    rerender({ ...makeOptions([], null), currentProvider: 'codex' });
    expect(result.current.ignoredLedgerKeys).toEqual([]);
  });
});

describe('Claude review compatibility', () => {
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  it('persists undo and discard, restores on reload and keeps sessions isolated', () => {
    const options = makeOptions(makeMessages(3), 'claude-one');
    const { result, unmount } = renderHook(() => useFileChangesManagement(options));
    act(() => result.current.handleUndoFile('/one.ts'));
    act(() => result.current.handleUndoFile('/one.ts'));
    act(() => result.current.handleDiscardAll([{ filePath: '/two.ts' }, { filePath: '/one.ts' }]));
    expect(result.current.processedFiles).toEqual(['/one.ts', '/two.ts']);
    unmount();
    const restored = renderHook(props => useFileChangesManagement(props), { initialProps: options });
    expect(restored.result.current.processedFiles).toEqual(['/one.ts', '/two.ts']);
    act(() => restored.result.current.handleKeepAll());
    expect(restored.result.current.processedFiles).toEqual([]);
    restored.unmount();
    const reloaded = renderHook(props => useFileChangesManagement(props), { initialProps: options });
    reloaded.rerender(makeOptions([], 'claude-two'));
    expect(reloaded.result.current.processedFiles).toEqual([]);
  });

  it('only marks successful Diff actions and tolerates incomplete callbacks', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useFileChangesManagement(makeOptions([], 'diff')));
    act(() => {
      window.handleRemoveFileFromEdits?.('broken');
      window.handleRemoveFileFromEdits?.('{}');
      window.handleDiffResult?.('broken');
      window.handleDiffResult?.(JSON.stringify({ filePath: '/failed.ts', action: 'APPLY', error: 'write failed' }));
      window.handleDiffResult?.(JSON.stringify({ filePath: '/dismissed.ts', action: 'DISMISS' }));
    });
    expect(result.current.processedFiles).toEqual([]);
    act(() => {
      window.handleDiffResult?.(JSON.stringify({ filePath: '/accepted.ts', action: 'APPLY' }));
      window.handleDiffResult?.(JSON.stringify({ filePath: '/accepted.ts', action: 'APPLY' }));
      window.handleRemoveFileFromEdits?.(JSON.stringify({ filePath: '/rejected.ts' }));
    });
    expect(result.current.processedFiles).toEqual(['/accepted.ts', '/rejected.ts']);
  });
});

describe('Native Diff APPLY receipts', () => {
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  const path = '/shared.ts';
  const nativeEdit = (id: string, before: string, after: string): ClaudeMessage => ({
    type: 'assistant', raw: { uuid: id, message: { content: [{ type: 'tool_use', id, name: 'file_change',
      input: { status: 'completed', changes: [{ path, kind: 'update', diff: `@@ -1 +1 @@\n-${before}\n+${after}` }] },
    }] } },
  });
  const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] =>
    typeof message.raw === 'object' && Array.isArray(message.raw.message?.content)
      ? message.raw.message.content.filter((block): block is ClaudeContentBlock => block.type !== 'tool_result') : [];
  const findToolResult = () => null;
  interface LedgerProps { sessionId: string | null; messages: ClaudeMessage[] }
  const props = (sessionId: string | null, messages: ClaudeMessage[]): LedgerProps => ({ sessionId, messages });
  const useReviewableLedger = ({ sessionId, messages }: LedgerProps) => {
    const sessionRef = useRef(sessionId);
    sessionRef.current = sessionId;
    const fileChangesRef = useRef<FileChangeSummary[]>([]);
    const management = useFileChangesManagement({ currentSessionId: sessionId, currentSessionIdRef: sessionRef,
      currentProvider: 'codex', messages, fileChangesRef, getContentBlocks, findToolResult });
    const files = useFileChanges({ messages, currentSessionId: sessionId, getContentBlocks, findToolResult,
      ignoredLedgerKeys: management.ignoredLedgerKeys });
    fileChangesRef.current = files;
    return { ...management, files };
  };
  const receipt = (sessionId: string | null, ledgerKeys: string[], error: string | null = null) => {
    act(() => window.handleDiffResult?.(JSON.stringify({ filePath: path, action: 'APPLY',
      sessionId, provider: 'codex', ledgerKeys, error })));
  };
  const keysFor = (files: FileChangeSummary[]) => files.flatMap(file =>
    file.operations.flatMap(operation => operation.ledgerKey ? [operation.ledgerKey] : []));

  it('checkpoints accepted A operations after switching to B and restores A without offering them for undo', () => {
    localStorage.setItem('codex-reviewed-edits-A', JSON.stringify(['reviewed-A']));
    localStorage.setItem('codex-reviewed-edits-B', JSON.stringify(['reviewed-B']));
    const a = [nativeEdit('A-first', 'old', 'accepted A')];
    const b = [nativeEdit('B-first', 'old', 'untouched B')];
    const { result, rerender } = renderHook(useReviewableLedger, { initialProps: props('A', a) });
    const frozenKeys = keysFor(result.current.files);
    expect(frozenKeys).toHaveLength(1);
    rerender(props('B', b));
    receipt('A', frozenKeys);
    expect(result.current.files).toMatchObject([{ filePath: path, operations: [{ newString: 'untouched B' }] }]);
    expect(result.current.ignoredLedgerKeys).toEqual(['reviewed-B']);
    expect(JSON.parse(localStorage.getItem('codex-reviewed-edits-A') ?? '[]')).toEqual(['reviewed-A', ...frozenKeys]);
    expect(JSON.parse(localStorage.getItem('codex-reviewed-edits-B') ?? '[]')).toEqual(['reviewed-B']);
    rerender(props('A', a));
    expect(result.current.files).toEqual([]);
  });

  it('keeps a later edit to the same A path reviewable when the Diff accepts its earlier frozen operations', () => {
    const first = nativeEdit('A-first', 'old', 'accepted A');
    const later = nativeEdit('A-later', 'accepted A', 'later A');
    const { result, rerender } = renderHook(useReviewableLedger, { initialProps: props('A', [first]) });
    const frozenKeys = keysFor(result.current.files);
    rerender(props('A', [first, later]));
    receipt('A', frozenKeys);
    expect(result.current.files).toMatchObject([{ filePath: path, operations: [{ newString: 'later A' }] }]);
    expect(keysFor(result.current.files)).toHaveLength(1);
    expect(keysFor(result.current.files)).not.toContain(frozenKeys[0]);
    expect(result.current.ignoredLedgerKeys).toEqual(frozenKeys);
  });

  it('keeps an explicitly anonymous APPLY origin out of an established B checkpoint', () => {
    const { result, rerender } = renderHook(useReviewableLedger, {
      initialProps: props(null, [nativeEdit('anonymous-first', 'old', 'anonymous')]),
    });
    const frozenKeys = keysFor(result.current.files);
    rerender(props('B', [nativeEdit('B-first', 'old', 'untouched B')]));
    receipt(null, frozenKeys);
    expect(result.current.files).toHaveLength(1);
    expect(result.current.ignoredLedgerKeys).toEqual([]);
    expect(localStorage.getItem('codex-reviewed-edits-B')).toBeNull();
    expect(localStorage.getItem('codex-reviewed-edits-null')).toBeNull();
  });

  it('leaves both sessions reviewable when A APPLY reports a write failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = [nativeEdit('A-first', 'old', 'unaccepted A')];
    const b = [nativeEdit('B-first', 'old', 'untouched B')];
    const { result, rerender } = renderHook(useReviewableLedger, { initialProps: props('A', a) });
    const frozenKeys = keysFor(result.current.files);
    rerender(props('B', b));
    receipt('A', frozenKeys, 'The file could not be saved');
    expect(result.current.files).toHaveLength(1);
    expect(result.current.ignoredLedgerKeys).toEqual([]);
    expect(localStorage.getItem('codex-reviewed-edits-A')).toBeNull();
    expect(localStorage.getItem('codex-reviewed-edits-B')).toBeNull();
    rerender(props('A', a));
    expect(result.current.files).toHaveLength(1);
  });
});
