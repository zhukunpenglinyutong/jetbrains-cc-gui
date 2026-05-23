import { describe, expect, it } from 'vitest';
import { getStructuralBlockSignature } from './toolBlockSignature';

describe('getStructuralBlockSignature', () => {
  it('changes when a tool_use input is filled after an early partial update', () => {
    const partial = getStructuralBlockSignature({
      type: 'tool_use',
      id: 'task-1',
      name: 'task',
      input: {},
    });
    const filled = getStructuralBlockSignature({
      type: 'tool_use',
      id: 'task-1',
      name: 'task',
      input: {
        subagent_type: 'explore',
        description: 'Inspect renderer',
      },
    });

    expect(filled).not.toBe(partial);
  });
});
