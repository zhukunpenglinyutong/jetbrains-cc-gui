import { renderHook } from '@testing-library/react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { SubagentHistoryResponse } from '../types/subagent';
import {
  useFileChanges,
  computeDiffStats,
  clearDiffCache,
} from './useFileChanges';
import { clearFileTouchRegistry } from '../utils/fileTouchRegistry';

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
