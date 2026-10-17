import { describe, expect, it } from 'vitest';
import { buildSubagentProcessModel } from './subagentProcess';
import type { SubagentHistoryResponse } from '../../types';

function assistantMessage(blocks: unknown[]) {
  return { type: 'assistant', message: { role: 'assistant', content: blocks } };
}

function userMessage(blocks: unknown[]) {
  return { type: 'user', message: { role: 'user', content: blocks } };
}

describe('buildSubagentProcessModel', () => {
  it('selects the latest native turn report even when only the earlier turn has final_answer phase', () => {
    const model = buildSubagentProcessModel({ success: true, completed: true, latestTurnId: 'new-turn', messages: [
      { type: 'assistant', raw: { codexTurnId: 'old-turn', codexPhase: 'final_answer', message: { content: [
        { type: 'text', text: 'Previous report' }, { type: 'thinking', thinking: 'Previous analysis' },
      ] } } },
      { type: 'assistant', raw: { codexTurnId: 'new-turn', message: { content: [
        { type: 'text', text: 'Current report without a phase' },
        { type: 'tool_use', id: 'current-read', name: 'Read', input: { file_path: '/src/current.ts' } },
      ] } } },
    ] });
    expect(model.resultText).toBe('Current report without a phase');
    expect(model.notes).toContain('Previous analysis');
    expect(model.readFiles).toContain('/src/current.ts');
  });
  it('reads native raw.message content and keeps the completed final answer as the report', () => {
    const history: SubagentHistoryResponse = { success: true, completed: true, messages: [
      { type: 'assistant', raw: { codexPhase: 'commentary', message: { content: [{ type: 'text', text: 'Checking the renderer' }] } } },
      { type: 'assistant', raw: { message: { content: [{ type: 'thinking', thinking: 'Check both cards' },
        { type: 'tool_use', id: 'native-read', name: 'Read', input: { file_path: '/src/view.ts' } }] } } },
      { type: 'assistant', raw: { codexPhase: 'final_answer', message: { content: [{ type: 'text', text: 'Review completed' }] } } },
    ] };
    expect(buildSubagentProcessModel(history)).toMatchObject({ notes: ['Check both cards'], readFiles: ['/src/view.ts'],
      resultText: 'Review completed' });
    expect(buildSubagentProcessModel({ ...history, completed: false }).resultText).toBeUndefined();
  });
  it('collects assistant thinking blocks into notes, not terminal text output', () => {
    const history: SubagentHistoryResponse = {
      success: true,
      completed: true,
      messages: [
        assistantMessage([
          { type: 'thinking', thinking: 'First reasoning step' },
        ]),
        assistantMessage([
          { type: 'thinking', thinking: 'Second reasoning step' },
        ]),
        assistantMessage([
          // The final assistant text block is the agent's terminal report; it
          // must not leak into the thought section (which would duplicate the
          // result section).
          { type: 'text', text: 'The investigation conclusion' },
        ]),
      ],
    };

    const model = buildSubagentProcessModel(history);
    expect(model.notes).toEqual(['First reasoning step', 'Second reasoning step']);
  });

  it('still extracts read files and tool calls alongside notes', () => {
    const history: SubagentHistoryResponse = {
      success: true,
      completed: true,
      messages: [
        assistantMessage([
          { type: 'thinking', thinking: 'Plan first' },
          { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/a/b/c/File.java' } },
          { type: 'tool_use', id: 'call-2', name: 'Grep', input: { pattern: 'foo' } },
        ]),
      ],
    };

    const model = buildSubagentProcessModel(history);
    expect(model.notes).toEqual(['Plan first']);
    expect(model.readFiles).toEqual(['/a/b/c/File.java']);
    expect(model.toolCalls).toEqual([{ id: '0-2', name: 'Grep', detail: 'foo' }]);
  });

  it('ignores user-message text blocks', () => {
    const history: SubagentHistoryResponse = {
      success: true,
      completed: true,
      messages: [
        userMessage([{ type: 'text', text: 'User prompt' }]),
      ],
    };

    const model = buildSubagentProcessModel(history);
    expect(model.notes).toEqual([]);
  });
});
