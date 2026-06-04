import { describe, expect, it } from 'vitest';
import { buildSubagentProcessModel } from './subagentProcess';
import type { SubagentHistoryResponse } from '../../types';

describe('buildSubagentProcessModel', () => {
  it('extracts notes and tool activity from normalized opencode child-session history', () => {
    const history: SubagentHistoryResponse = {
      success: true,
      sessionId: 'ses_child',
      messages: [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I will inspect the task renderer.' },
              {
                type: 'tool_use',
                id: 'tool_read_1',
                name: 'read',
                input: { file_path: 'src/components/toolBlocks/TaskExecutionBlock.tsx' },
              },
              {
                type: 'tool_use',
                id: 'tool_search_1',
                name: 'grep',
                input: { pattern: 'task_id' },
              },
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'The child session is available for status-panel details.' },
            ],
          },
        },
      ],
    };

    expect(buildSubagentProcessModel(history)).toEqual({
      notes: [
        'I will inspect the task renderer.',
        'The child session is available for status-panel details.',
      ],
      readFiles: ['src/components/toolBlocks/TaskExecutionBlock.tsx'],
      toolCalls: [{ id: '0-2', name: 'grep', detail: 'task_id' }],
    });
  });
});
