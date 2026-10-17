import { act, renderHook } from '@testing-library/react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { SubagentHistoryResponse } from '../types/subagent';
import {
  useFileChanges,
  computeDiffStats,
  clearDiffCache,
} from './useFileChanges';
import { clearFileTouchRegistry, recordFileTouches } from '../utils/fileTouchRegistry';
import * as fileLedger from '../utils/sessionFileLedger';
import * as toolInputNormalization from '../utils/toolInputNormalization';

describe('file ledger work budget', () => {
  const store = new Map<string, string>();
  const reads = vi.fn((key: string) => store.get(key) ?? null);
  const writes = vi.fn((key: string, value: string) => { store.set(key, value); });
  const edit = (id = 'edit', path = '/budget.ts', old = 'before', next = 'after') =>
    assistantWithTools([{ id, name: 'Edit', input: { file_path: path, old_string: old, new_string: next } }]);
  const snapshot = (messages: ClaudeMessage[], session = 'session-a', startFromIndex = 0) => ({
    messages, currentSessionId: session, startFromIndex, getContentBlocks,
    findToolResult: makeFindToolResult(messages),
  });

  it('collects every completed native patch file without requiring a separate result', () => {
    const messages = [assistantWithTools([{ id: 'native', name: 'file_change', input: { status: 'completed', changes: [
      { path: '/added.ts', kind: 'add', diff: '+created\n' },
      { path: '/old.ts', kind: { type: 'update', movePath: '/moved.ts' }, diff: '@@ -1 +1 @@\n-before\n+after\n' },
      { path: '/gone.ts', kind: 'delete', diff: '-removed\n' },
    ] } }])];
    const { result } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    expect(result.current.map(file => file.filePath).sort()).toEqual(['/added.ts', '/gone.ts', '/moved.ts']);
    expect(result.current.find(file => file.filePath === '/added.ts')).toMatchObject({ status: 'A', additions: 1 });
    expect(result.current.find(file => file.filePath === '/gone.ts')).toMatchObject({ status: 'D', deletions: 1 });
    expect(result.current.find(file => file.filePath === '/moved.ts')).toMatchObject({ status: 'R', additions: 1, deletions: 1 });
    expect(result.current.find(file => file.filePath === '/moved.ts')?.operations[0]).toMatchObject({ moveFrom: '/old.ts', toolUseId: 'native' });
  });

  it('keeps completed apply_patch edits across turns and ignores proposed or failed patches', () => {
    const patch = '*** Begin Patch\n*** Update File: /session.ts\n@@\n-before\n+after\n*** End Patch';
    const messages = [assistantWithTools([{ id: 'first', name: 'functions.apply_patch', input: { patch } }]),
      userWithResults([{ toolUseId: 'first' }]), { type: 'user', content: 'next turn' } as ClaudeMessage,
      assistantWithTools([{ id: 'failed', name: 'file_change', input: { changes: [{ path: '/failed.ts', kind: 'add', diff: '+failed' }], status: 'failed' } },
        { id: 'unknown', name: 'apply_patch', input: { patch, status: 'unknown' } }])];
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    expect(result.current.map(file => file.filePath)).toEqual(['/session.ts']);
    expect(result.current[0].operations).toHaveLength(1);
    rerender(snapshot(JSON.parse(JSON.stringify(messages))));
    expect(result.current[0].operations).toHaveLength(1);
  });

  beforeEach(() => {
    store.clear();
    reads.mockClear();
    writes.mockClear();
    vi.stubGlobal('localStorage', { getItem: reads, setItem: writes, removeItem: (key: string) => store.delete(key) });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([1, 12])('does zero ledger rebuilds and storage work during 30 text updates after %i edits', (count) => {
    const build = vi.spyOn(fileLedger, 'buildSessionFileLedger');
    const normalize = vi.spyOn(toolInputNormalization, 'normalizeToolInput');
    const history = [
      ...Array.from({ length: 200 }, (_, index): ClaudeMessage => ({ type: 'user', content: `history ${index}` })),
      ...Array.from({ length: count }, (_, index) => edit(`edit-${index}`, `/budget-${index}.ts`)),
      userWithResults(Array.from({ length: count }, (_, index) => ({ toolUseId: `edit-${index}` }))),
      edit('pending', '/pending.ts'),
    ];
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot(history) });
    const initial = result.current;
    const persisted = [...store.entries()];
    build.mockClear();
    normalize.mockClear();
    reads.mockClear();
    writes.mockClear();

    for (let index = 0; index < 30; index += 1) {
      rerender(snapshot([...history, { type: 'assistant', content: `text ${index}` }]));
    }

    expect({ rebuilds: build.mock.calls.length, reads: reads.mock.calls.length, writes: writes.mock.calls.length })
      .toEqual({ rebuilds: 0, reads: 0, writes: 0 });
    expect(result.current).toBe(initial);
    expect(result.current).toHaveLength(count);
    expect(normalize).not.toHaveBeenCalled();
    expect([...store.entries()]).toEqual(persisted);
  });

  it('reuses equivalent snapshots and deduplicates repeated tool ids', () => {
    const build = vi.spyOn(fileLedger, 'buildSessionFileLedger');
    const messages = [edit(), userWithResults([{ toolUseId: 'edit' }])];
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    const initial = result.current;
    build.mockClear();
    writes.mockClear();
    rerender(snapshot([...JSON.parse(JSON.stringify(messages)), edit()]));
    expect(result.current[0].operations).toHaveLength(1);
    expect(build).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(result.current).toBe(initial);
  });

  it('records only the changed path and reads storage once per new operation', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const history = [edit(), userWithResults([{ toolUseId: 'edit' }])];
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot(history) });
    reads.mockClear();
    writes.mockClear();
    now.mockReturnValue(2000);
    rerender(snapshot([...history, edit('second', '/second.ts'), userWithResults([{ toolUseId: 'second' }])]));
    expect(result.current).toHaveLength(2);
    const actors = JSON.parse([...store.values()][0]);
    expect(actors['/budget.ts'][0].updatedAt).toBe(1000);
    expect(actors['/second.ts'][0].updatedAt).toBe(2000);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('updates pending, failed, successful and revised results without stale statistics', () => {
    const tool = edit();
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot([tool]) });
    expect(result.current).toEqual([]);
    rerender(snapshot([tool, userWithResults([{ toolUseId: 'edit', isError: true }])]));
    expect(result.current).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    rerender(snapshot([tool, userWithResults([{ toolUseId: 'edit' }])]));
    expect(result.current[0].additions).toBe(1);
    rerender(snapshot([edit('edit', '/budget.ts', 'before', 'after\nextra'), userWithResults([{ toolUseId: 'edit' }])]));
    expect(result.current[0].additions).toBe(2);
    rerender(snapshot([tool, userWithResults([{ toolUseId: 'edit', isError: true }])]));
    expect(result.current).toEqual([]);
  });

  it('resets on Keep All, clearing, restoration and session changes with reused ids', () => {
    const messages = [edit(), userWithResults([{ toolUseId: 'edit' }])];
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    rerender(snapshot(messages, 'session-a', messages.length));
    expect(result.current).toEqual([]);
    rerender(snapshot([]));
    expect(result.current).toEqual([]);
    rerender(snapshot(messages));
    expect(result.current[0].operations).toHaveLength(1);
    rerender(snapshot([edit('edit', '/other.ts'), messages[1]], 'session-b'));
    expect(result.current.map((entry) => entry.filePath)).toEqual(['/other.ts']);
    rerender(snapshot(messages));
    expect(result.current.map((entry) => entry.filePath)).toEqual(['/budget.ts']);
  });

  it('keeps outside-session Write status when recording evicts the outside actor', () => {
    vi.useFakeTimers();
    store.set('ccgui-file-touch-registry-v1', JSON.stringify({
      '/shared.ts': [{ sessionId: 'outside', agentId: 'main', updatedAt: Date.now() - 1 }],
    }));
    const tools = Array.from({ length: 12 }, (_, index) => [
      { id: `agent-${index}`, name: 'Task', input: {} },
      { id: `write-${index}`, name: 'Write', input: { file_path: '/shared.ts', content: `version ${index}` } },
    ]).flat();
    const messages = [assistantWithTools(tools), userWithResults(tools.map((tool) => ({ toolUseId: tool.id })))];
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    expect(result.current[0].status).toBe('M');
    expect(result.current[0].multiAgent).toBe(true);
    rerender(snapshot([...messages, edit('unrelated', '/other.ts'), userWithResults([{ toolUseId: 'unrelated' }])]));
    expect(result.current.find((entry) => entry.filePath === '/shared.ts')?.status).toBe('M');
    act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1));
    expect(result.current.find((entry) => entry.filePath === '/shared.ts')?.status).toBe('A');
  });

  it('deduplicates main snapshots by source when their owner changes', () => {
    const grouped = assistantWithTools([
      { id: 'agent', name: 'Task', input: {} },
      { id: 'edit', name: 'Edit', input: { file_path: '/budget.ts', old_string: 'before', new_string: 'after' } },
    ]);
    const messages = [grouped, userWithResults([{ toolUseId: 'edit' }])];
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    expect(result.current[0].agentIds).toEqual(['agent']);
    rerender(snapshot([...messages, edit()]));
    expect(result.current[0].operations).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ additions: 1, deletions: 1, agentIds: ['main'], multiAgent: false });
    const actors = JSON.parse([...store.values()][0])['/budget.ts'];
    expect(actors.map((actor: { agentId: string }) => actor.agentId)).toEqual(['main']);
  });

  it('keeps colliding tool ids from distinct subagent sources separate', () => {
    const history = (path: string): SubagentHistoryResponse => ({
      success: true, agentId: 'same-owner',
      messages: [edit('edit', path), userWithResults([{ toolUseId: 'edit' }])].map((message) => message.raw),
    });
    const { result } = renderHook(useFileChanges, { initialProps: {
      ...snapshot([]), subagentHistories: { first: history('/first.ts'), second: history('/second.ts') },
    } });
    expect(result.current.map((entry) => entry.filePath)).toEqual(['/first.ts', '/second.ts']);
  });

  it('refreshes already mounted sessions when another session touches the same file', () => {
    const messages = [edit(), userWithResults([{ toolUseId: 'edit' }])];
    const first = renderHook(useFileChanges, { initialProps: snapshot(messages, 'first') });
    expect(first.result.current[0].multiAgent).toBe(false);
    const second = renderHook(useFileChanges, { initialProps: snapshot(messages, 'second') });
    expect(first.result.current[0].multiAgent).toBe(true);
    expect(second.result.current[0].multiAgent).toBe(true);
    reads.mockClear();
    writes.mockClear();
    for (let index = 0; index < 30; index += 1) {
      first.rerender(snapshot([...messages, { type: 'assistant', content: `text ${index}` }], 'first'));
    }
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it('refreshes remote storage changes without recording the current operations again', () => {
    const messages = [edit(), userWithResults([{ toolUseId: 'edit' }])];
    const { result } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    const key = 'ccgui-file-touch-registry-v1';
    const map = JSON.parse(store.get(key)!);
    map['/budget.ts'].push({ sessionId: 'remote', agentId: 'main', updatedAt: Date.now() });
    store.set(key, JSON.stringify(map));
    writes.mockClear();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key })));
    expect(result.current[0].multiAgent).toBe(true);
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps registry events current while Keep All temporarily hides the ledger', () => {
    const messages = [edit(), userWithResults([{ toolUseId: 'edit' }])];
    const first = renderHook(useFileChanges, { initialProps: snapshot(messages, 'first') });
    first.rerender(snapshot(messages, 'first', messages.length));
    expect(first.result.current).toEqual([]);
    renderHook(useFileChanges, { initialProps: snapshot(messages, 'second') });
    reads.mockClear();
    writes.mockClear();
    first.rerender(snapshot(messages, 'first'));
    expect(first.result.current[0].multiAgent).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it('releases expiry timers on unmount and discards outside evidence on registry clear', () => {
    vi.useFakeTimers();
    recordFileTouches(['/budget.ts'], 'outside', new Map());
    const messages = [assistantWithTools([
      { id: 'write', name: 'Write', input: { file_path: '/budget.ts', content: 'new' } },
    ]), userWithResults([{ toolUseId: 'write' }])];
    const { result, unmount } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    expect(result.current[0]).toMatchObject({ status: 'M', multiAgent: true });
    expect(vi.getTimerCount()).toBe(1);
    act(() => clearFileTouchRegistry());
    expect(result.current[0]).toMatchObject({ status: 'A', multiAgent: false });
    act(() => recordFileTouches(['/budget.ts'], 'outside', new Map()));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => recordFileTouches(['/budget.ts'], 'another', new Map()));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timer', 'revision'])('expires external actors through %s without text-driven storage work', (mode) => {
    vi.useFakeTimers();
    const start = Date.now();
    recordFileTouches(['/budget.ts'], 'outside', new Map(), start);
    vi.setSystemTime(start + 1000);
    const messages = [edit(), userWithResults([{ toolUseId: 'edit' }])];
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    expect(result.current[0].multiAgent).toBe(true);
    reads.mockClear();
    writes.mockClear();
    if (mode === 'timer') {
      act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 999));
    } else {
      vi.setSystemTime(start + 24 * 60 * 60 * 1000 + 1);
      rerender(snapshot([edit('edit', '/budget.ts', 'before', 'after\nrevised'), messages[1]]));
    }
    expect(result.current[0].multiAgent).toBe(false);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it('refreshes timestamps for a distinct operation, but not a revised result', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const messages = [edit(), userWithResults([{ toolUseId: 'edit' }])];
    const { result, rerender } = renderHook(useFileChanges, { initialProps: snapshot(messages) });
    reads.mockClear();
    writes.mockClear();
    now.mockReturnValue(2000);
    const revisedResult = userWithResults([{ toolUseId: 'edit' }]);
    (getContentBlocks(revisedResult)[0] as unknown as ToolResultBlock).content = '@@ -10,1 +10,2 @@\n-before\n+after\n+extra';
    rerender(snapshot([messages[0], revisedResult]));
    expect(result.current[0].lineStart).toBe(10);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    rerender(snapshot([...messages, edit('next', '/budget.ts', 'after', 'before'), userWithResults([{ toolUseId: 'next' }])]));
    expect(result.current[0].operations).toHaveLength(2);
    expect(result.current[0].additions).toBe(0);
    expect(result.current[0].deletions).toBe(0);
    expect(JSON.parse([...store.values()][0])['/budget.ts'][0].updatedAt).toBe(2000);
  });

  it('preserves subagent work across text-only history updates and applies a new edit', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const build = vi.spyOn(fileLedger, 'buildSessionFileLedger');
    const history = (messages: ClaudeMessage[]): Record<string, SubagentHistoryResponse> => ({
      task: { success: true, agentId: 'sub', toolUseId: 'task', messages: messages.map((message) => message.raw) },
    });
    const subMessages = [edit(), userWithResults([{ toolUseId: 'edit' }])];
    const props = { ...snapshot([]), subagentHistories: history(subMessages) };
    const { result, rerender } = renderHook(useFileChanges, { initialProps: props });
    const initial = result.current;
    build.mockClear();
    reads.mockClear();
    writes.mockClear();
    for (let index = 0; index < 30; index += 1) {
      rerender({ ...props, subagentHistories: history([...subMessages, { type: 'assistant', content: `text ${index}` }]) });
    }
    expect(result.current).toBe(initial);
    expect(build).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    now.mockReturnValue(2000);
    rerender({ ...props, subagentHistories: history([
      ...subMessages, edit('other', '/other.ts'), userWithResults([{ toolUseId: 'other' }]),
    ]) });
    expect(JSON.parse([...store.values()][0])['/budget.ts'][0].updatedAt).toBe(1000);
    rerender({ ...props, subagentHistories: history([
      ...subMessages, edit('next', '/budget.ts', 'after', 'before'), userWithResults([{ toolUseId: 'next' }]),
    ]) });
    expect(result.current[0].operations).toHaveLength(2);
    expect(result.current[0].additions).toBe(0);
    expect(result.current[0].agentIds).toEqual(['sub']);
  });
});

function lines(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i}`).join('\n');
}

function assistantWithTools(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): ClaudeMessage {
  return {
    type: 'assistant',
    content: '',
    raw: {
      role: 'assistant',
      content: tools.map((t) => ({
        type: 'tool_use',
        id: t.id,
        name: t.name,
        input: t.input,
      })),
    },
  } as ClaudeMessage;
}

function userWithResults(
  results: Array<{ toolUseId: string; isError?: boolean }>,
): ClaudeMessage {
  return {
    type: 'user',
    content: '',
    raw: {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.toolUseId,
        is_error: r.isError === true,
        content: r.isError ? 'error' : 'ok',
      })),
    },
  } as ClaudeMessage;
}

function getContentBlocks(message: ClaudeMessage): ClaudeContentBlock[] {
  const raw = message.raw;
  if (!raw || typeof raw === 'string') return [];
  const content = (raw as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ClaudeContentBlock[]) : [];
}

function makeFindToolResult(messages: ClaudeMessage[]) {
  return (toolUseId?: string): ToolResultBlock | null => {
    if (!toolUseId) return null;
    for (const msg of messages) {
      const raw = msg.raw;
      if (!raw || typeof raw === 'string') continue;
      const content = (raw as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;
      const hit = content.find(
        (b): b is ToolResultBlock =>
          Boolean(b)
          && (b as ToolResultBlock).type === 'tool_result'
          && (b as ToolResultBlock).tool_use_id === toolUseId,
      );
      if (hit) return hit;
    }
    return null;
  };
}

describe('computeDiffStats', () => {
  beforeEach(() => {
    clearDiffCache();
    clearFileTouchRegistry();
  });

  it('counts equal-size large replacements as both additions and deletions', () => {
    const oldString = lines(120, 'old');
    const newString = lines(120, 'new');
    const stats = computeDiffStats(oldString, newString);
    expect(stats.additions).toBe(120);
    expect(stats.deletions).toBe(120);
  });

  it('counts large replacements that only change a few lines net correctly', () => {
    const oldLines = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[10] = 'changed 10';
    newLines[11] = 'changed 11';
    newLines[12] = 'changed 12';
    // net +0 lines, but 3 replaced
    const stats = computeDiffStats(oldLines.join('\n'), newLines.join('\n'));
    expect(stats.additions).toBe(3);
    expect(stats.deletions).toBe(3);
  });

  it('does not collide cache keys for same-length different content', () => {
    const prefix = 'x'.repeat(50);
    const oldA = `${prefix}AAA${'y'.repeat(50)}`;
    const newA = `${prefix}BBB${'y'.repeat(50)}`;
    const oldB = `${prefix}CCC${'y'.repeat(50)}`;
    const newB = `${prefix}DDD${'y'.repeat(50)}`;

    const statsA = computeDiffStats(oldA, newA);
    const statsB = computeDiffStats(oldB, newB);

    // Both are single-line full replacements → each should be +1 -1
    expect(statsA).toEqual({ additions: 1, deletions: 1 });
    expect(statsB).toEqual({ additions: 1, deletions: 1 });
  });

  it('counts write-style empty old as pure additions', () => {
    expect(computeDiffStats('', 'a\nb\nc')).toEqual({ additions: 3, deletions: 0 });
  });
});

describe('useFileChanges', () => {
  beforeEach(() => {
    clearDiffCache();
    clearFileTouchRegistry();
    // jsdom localStorage
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  it('counts Grok-style Search Replace tools in the Edits ledger', () => {
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'sr1',
          name: 'Search Replace',
          input: {
            file_path: '/Users/hpstream/Desktop/code/my-knowledge/name.js',
            old_string: '',
            new_string: '123',
          },
        },
      ]),
      userWithResults([{ toolUseId: 'sr1' }]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0].fileName).toBe('name.js');
    expect(result.current[0].status).toBe('A');
    expect(result.current[0].additions).toBe(1);
    expect(result.current[0].deletions).toBe(0);
  });

  it('aggregates multiple successful Edit tools into separate file entries', () => {
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'e1',
          name: 'Edit',
          input: { file_path: '/proj/a.ts', old_string: 'a', new_string: 'A' },
        },
        {
          id: 'e2',
          name: 'Edit',
          input: { file_path: '/proj/b.ts', old_string: 'b', new_string: 'B' },
        },
        {
          id: 'e3',
          name: 'Write',
          input: { file_path: '/proj/c.ts', content: 'hello\nworld' },
        },
        {
          id: 'e4',
          name: 'Edit',
          input: { file_path: '/proj/d.ts', old_string: 'd1\nd2', new_string: 'D1' },
        },
      ]),
      userWithResults([
        { toolUseId: 'e1' },
        { toolUseId: 'e2' },
        { toolUseId: 'e3' },
        { toolUseId: 'e4' },
      ]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(4);
    const paths = result.current.map((f) => f.filePath).sort();
    expect(paths).toEqual(['/proj/a.ts', '/proj/b.ts', '/proj/c.ts', '/proj/d.ts']);
  });

  it('includes MultiEdit tool and expands edits[] for stats', () => {
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'm1',
          name: 'MultiEdit',
          input: {
            file_path: '/proj/multi.ts',
            edits: [
              { old_string: 'foo', new_string: 'bar' },
              { old_string: 'one\ntwo', new_string: 'ONE' },
            ],
          },
        },
      ]),
      userWithResults([{ toolUseId: 'm1' }]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(1);
    const file = result.current[0];
    expect(file.filePath).toBe('/proj/multi.ts');
    // edit1: +1 -1, edit2: +1 -2 → totals +2 -3
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(3);
    expect(file.operations).toHaveLength(2);
  });

  it('counts large equal-line Edit stats correctly in the hook', () => {
    const oldString = lines(110, 'old');
    const newString = lines(110, 'new');
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'big',
          name: 'Edit',
          input: { file_path: '/proj/big.ts', old_string: oldString, new_string: newString },
        },
      ]),
      userWithResults([{ toolUseId: 'big' }]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current[0].additions).toBe(110);
    expect(result.current[0].deletions).toBe(110);
  });

  it('includes successful Edit tools from subagent histories', () => {
    const mainMessages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'agent-1',
          name: 'Agent',
          input: { description: 'edit files', prompt: 'go', subagent_type: 'general-purpose' },
        },
      ]),
      userWithResults([{ toolUseId: 'agent-1' }]),
    ];

    const subagentHistories: Record<string, SubagentHistoryResponse> = {
      'agent-1': {
        success: true,
        toolUseId: 'agent-1',
        messages: [
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'sub-edit-1',
                  name: 'Edit',
                  input: {
                    file_path: '/proj/from-agent.ts',
                    old_string: 'x',
                    new_string: 'y',
                  },
                },
              ],
            },
          },
          {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'sub-edit-1',
                  content: 'ok',
                },
              ],
            },
          },
        ],
      },
    };

    const { result } = renderHook(() =>
      useFileChanges({
        messages: mainMessages,
        getContentBlocks,
        findToolResult: makeFindToolResult(mainMessages),
        subagentHistories,
      }),
    );

    expect(result.current.map((f) => f.filePath)).toContain('/proj/from-agent.ts');
  });

  it('skips failed tool results', () => {
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'ok',
          name: 'Edit',
          input: { file_path: '/proj/ok.ts', old_string: 'a', new_string: 'b' },
        },
        {
          id: 'fail',
          name: 'Edit',
          input: { file_path: '/proj/fail.ts', old_string: 'a', new_string: 'b' },
        },
      ]),
      userWithResults([
        { toolUseId: 'ok' },
        { toolUseId: 'fail', isError: true },
      ]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0].filePath).toBe('/proj/ok.ts');
  });

  it('uses net session stats for sequential edits on same file (not op sum)', () => {
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'e1',
          name: 'Edit',
          input: { file_path: '/proj/net.ts', old_string: 'alpha', new_string: 'beta' },
        },
        {
          id: 'e2',
          name: 'Edit',
          input: { file_path: '/proj/net.ts', old_string: 'beta', new_string: 'alpha' },
        },
      ]),
      userWithResults([{ toolUseId: 'e1' }, { toolUseId: 'e2' }]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(1);
    // Reverted to original content → net 0 (sum would be +2 -2)
    expect(result.current[0].additions).toBe(0);
    expect(result.current[0].deletions).toBe(0);
    expect(result.current[0].operations).toHaveLength(2);
  });

  it('marks multiAgent when main and subagent both edit the same file', () => {
    // Main Edit must come *before* Agent/Task (or after a text boundary); otherwise
    // groupBlocks-style absorption attributes it to the agent and both ops share one id.
    const mainMessages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'main-edit',
          name: 'Edit',
          input: { file_path: '/proj/shared.ts', old_string: 'start', new_string: 'mid' },
        },
        {
          id: 'agent-1',
          name: 'Agent',
          input: { description: 'edit', prompt: 'go', subagent_type: 'general-purpose' },
        },
      ]),
      userWithResults([{ toolUseId: 'main-edit' }, { toolUseId: 'agent-1' }]),
    ];

    const subagentHistories: Record<string, SubagentHistoryResponse> = {
      'agent-1': {
        success: true,
        toolUseId: 'agent-1',
        agentId: 'agent-1',
        messages: [
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'sub-edit',
                  name: 'Edit',
                  input: {
                    file_path: '/proj/shared.ts',
                    old_string: 'mid',
                    new_string: 'end',
                  },
                },
              ],
            },
          },
          {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'sub-edit',
                  content: 'ok',
                },
              ],
            },
          },
        ],
      },
    };

    const { result } = renderHook(() =>
      useFileChanges({
        messages: mainMessages,
        getContentBlocks,
        findToolResult: makeFindToolResult(mainMessages),
        subagentHistories,
      }),
    );

    const shared = result.current.find((f) => f.filePath === '/proj/shared.ts');
    expect(shared).toBeDefined();
    expect(shared!.multiAgent).toBe(true);
    expect(shared!.agentIds).toEqual(expect.arrayContaining(['main', 'agent-1']));
    // net start → end
    expect(shared!.additions).toBe(1);
    expect(shared!.deletions).toBe(1);
  });

  it('attributes Edit tools absorbed after Task/Agent to that agent (multi-agent badge)', () => {
    // Mirrors groupBlocks: Task absorbs following tool_use until a text boundary.
    // Two agents each followed by an Edit on the same file → multiAgent.
    const messages: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: '',
        raw: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'task-a',
              name: 'Task',
              input: { description: 'agent A', prompt: 'edit', subagent_type: 'general-purpose' },
            },
            {
              type: 'tool_use',
              id: 'edit-a',
              name: 'Edit',
              input: { file_path: '/proj/shared.ts', old_string: 'a', new_string: 'b' },
            },
            {
              type: 'tool_use',
              id: 'task-b',
              name: 'Task',
              input: { description: 'agent B', prompt: 'edit', subagent_type: 'general-purpose' },
            },
            {
              type: 'tool_use',
              id: 'edit-b',
              name: 'Edit',
              input: { file_path: '/proj/shared.ts', old_string: 'b', new_string: 'c' },
            },
          ],
        },
      } as ClaudeMessage,
      userWithResults([
        { toolUseId: 'task-a' },
        { toolUseId: 'edit-a' },
        { toolUseId: 'task-b' },
        { toolUseId: 'edit-b' },
      ]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0].filePath).toBe('/proj/shared.ts');
    expect(result.current[0].multiAgent).toBe(true);
    expect(result.current[0].agentIds).toEqual(expect.arrayContaining(['task-a', 'task-b']));
  });

  it('keeps main attribution for Edit before any Agent/Task in the same message', () => {
    const messages: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: '',
        raw: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'edit-main',
              name: 'Write',
              input: { file_path: '/proj/only-main.ts', content: 'x\ny' },
            },
            {
              type: 'tool_use',
              id: 'task-1',
              name: 'Agent',
              input: { description: 'later', prompt: 'go', subagent_type: 'general-purpose' },
            },
          ],
        },
      } as ClaudeMessage,
      userWithResults([{ toolUseId: 'edit-main' }, { toolUseId: 'task-1' }]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
      }),
    );

    expect(result.current[0].multiAgent).toBeFalsy();
    expect(result.current[0].agentIds).toEqual(['main']);
  });

  it('marks multiAgent across two chat sessions (AI1 + AI2 tabs) on the same file', () => {
    const path = '/Users/hpstream/Desktop/code/my-knowledge/name.js';
    const makeMessages = (id: string, content: string): ClaudeMessage[] => [
      assistantWithTools([
        {
          id,
          name: 'Write',
          input: { file_path: path, content },
        },
      ]),
      userWithResults([{ toolUseId: id }]),
    ];

    const messages1 = makeMessages('w1', '123');
    const { result: r1 } = renderHook(() =>
      useFileChanges({
        messages: messages1,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages1),
        currentSessionId: 'AI1',
      }),
    );
    expect(r1.current[0].multiAgent).toBeFalsy();

    const messages2 = makeMessages('w2', '234');
    const { result: r2 } = renderHook(() =>
      useFileChanges({
        messages: messages2,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages2),
        currentSessionId: 'AI2',
      }),
    );

    expect(r2.current[0].filePath).toBe(path);
    expect(r2.current[0].multiAgent).toBe(true);
    // Another tab already created/touched the file → show M not A
    expect(r2.current[0].status).toBe('M');
  });

  it('respects startFromIndex (Keep All baseline) when rebuilding from history', () => {
    const messages: ClaudeMessage[] = [
      assistantWithTools([
        {
          id: 'old',
          name: 'Edit',
          input: { file_path: '/proj/old.ts', old_string: 'a', new_string: 'b' },
        },
      ]),
      userWithResults([{ toolUseId: 'old' }]),
      assistantWithTools([
        {
          id: 'new',
          name: 'Edit',
          input: { file_path: '/proj/new.ts', old_string: 'c', new_string: 'd' },
        },
      ]),
      userWithResults([{ toolUseId: 'new' }]),
    ];

    const { result } = renderHook(() =>
      useFileChanges({
        messages,
        getContentBlocks,
        findToolResult: makeFindToolResult(messages),
        startFromIndex: 2,
      }),
    );

    expect(result.current.map((f) => f.filePath)).toEqual(['/proj/new.ts']);
  });
});
