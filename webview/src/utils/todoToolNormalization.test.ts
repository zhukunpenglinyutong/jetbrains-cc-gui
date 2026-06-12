import { describe, it, expect } from 'vitest';
import { extractAccumulatedTasks } from './todoToolNormalization';
import type { ClaudeMessage, ClaudeContentBlock } from '../types';

// getContentBlocks stub: assistant blocks are stashed on a test-only field.
interface TestMsg extends ClaudeMessage {
  __blocks?: ClaudeContentBlock[];
}
const getBlocks = (msg: ClaudeMessage): ClaudeContentBlock[] => (msg as TestMsg).__blocks ?? [];

const assistant = (blocks: ClaudeContentBlock[]): ClaudeMessage =>
  ({ type: 'assistant', __blocks: blocks }) as TestMsg;

const toolUse = (id: string, name: string, input: Record<string, unknown>): ClaudeContentBlock =>
  ({ type: 'tool_use', id, name, input });

const userResults = (
  results: Array<{ tool_use_id: string; content?: string }>,
  toolUseResult?: unknown,
): ClaudeMessage =>
  ({
    type: 'user',
    raw: {
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content ?? '' })),
      ...(toolUseResult !== undefined ? { toolUseResult } : {}),
    },
  }) as ClaudeMessage;

describe('extractAccumulatedTasks', () => {
  it('resolves the real task id from a single tool_result toolUseResult.task.id', () => {
    const messages = [
      assistant([toolUse('tu-1', 'TaskCreate', { subject: 'Build', description: 'X' })]),
      userResults([{ tool_use_id: 'tu-1' }], { task: { id: 1 } }),
    ];
    expect(extractAccumulatedTasks(messages, getBlocks)).toEqual([
      { id: '1', content: 'Build: X', status: 'pending' },
    ]);
  });

  it('does NOT mis-attribute ids when one user message bundles multiple tool_results (M1 regression)', () => {
    // The single message-level toolUseResult.task.id (here: 1) must be ignored when the
    // message carries several tool_results; otherwise both TaskCreates collapse onto id "1"
    // and one task silently disappears. Falls back to per-block content parsing instead.
    const messages = [
      assistant([
        toolUse('tu-1', 'TaskCreate', { subject: 'Task A' }),
        toolUse('tu-2', 'TaskCreate', { subject: 'Task B' }),
      ]),
      userResults(
        [
          { tool_use_id: 'tu-1', content: 'Task #1 created successfully' },
          { tool_use_id: 'tu-2', content: 'Task #2 created successfully' },
        ],
        { task: { id: 1 } },
      ),
    ];
    expect(extractAccumulatedTasks(messages, getBlocks)).toEqual([
      { id: '1', content: 'Task A', status: 'pending' },
      { id: '2', content: 'Task B', status: 'pending' },
    ]);
  });

  it('applies TaskUpdate status changes and deletion', () => {
    const base = [
      assistant([toolUse('c1', 'TaskCreate', { subject: 'A' })]),
      userResults([{ tool_use_id: 'c1' }], { task: { id: 1 } }),
      assistant([toolUse('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })]),
    ];
    expect(extractAccumulatedTasks(base, getBlocks)).toEqual([
      { id: '1', content: 'A', status: 'in_progress' },
    ]);

    const withDelete = [...base, assistant([toolUse('u2', 'TaskUpdate', { taskId: '1', status: 'deleted' })])];
    expect(extractAccumulatedTasks(withDelete, getBlocks)).toEqual([]);
  });

  it('records blockedBy from addBlockedBy', () => {
    const messages = [
      assistant([
        toolUse('c1', 'TaskCreate', { subject: 'A' }),
        toolUse('c2', 'TaskCreate', { subject: 'B' }),
      ]),
      userResults([
        { tool_use_id: 'c1', content: 'Task #1 created' },
        { tool_use_id: 'c2', content: 'Task #2 created' },
      ]),
      assistant([toolUse('u1', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] })]),
    ];
    const tasks = extractAccumulatedTasks(messages, getBlocks);
    expect(tasks.find((task) => task.id === '2')?.blockedBy).toEqual(['1']);
  });

  it('returns [] when there are no task tools', () => {
    expect(
      extractAccumulatedTasks([assistant([toolUse('x', 'Read', { file_path: 'a.ts' })])], getBlocks),
    ).toEqual([]);
    expect(extractAccumulatedTasks([], getBlocks)).toEqual([]);
  });
});
