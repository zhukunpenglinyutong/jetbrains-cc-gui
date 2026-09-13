import { describe, expect, it } from 'vitest';
import type { ClaudeContentBlock, ClaudeMessage, ToolResultBlock } from '../types';
import { applySubagentHistoryCompletion, extractSubagentsFromMessages } from './useSubagents';

const assistantWithAgent = (toolUseId: string): ClaudeMessage => ({
  type: 'assistant',
  content: '',
  raw: {
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Agent',
          input: {
            subagent_type: 'research',
            description: '分析后端历史索引服务的设计模式',
            prompt: '分析 ClaudeHistoryIndexService',
          },
        },
      ],
    },
  },
});

const toolResultMessage = (toolUseId: string): ClaudeMessage => ({
  type: 'user',
  content: '',
  raw: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: 'final report' }],
      },
    ],
    toolUseResult: {
      status: 'completed',
      agentId: 'af5a83aa15ca39691',
      agentType: 'research',
      totalDurationMs: 62629,
      totalTokens: 110586,
      totalToolUseCount: 4,
      toolStats: { readCount: 4, searchCount: 0 },
    },
  } as any,
});

const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] => {
  const raw = message.raw;
  if (!raw || typeof raw === 'string') return [];
  const content = raw.message?.content ?? raw.content;
  return Array.isArray(content) ? content.filter((block): block is ClaudeContentBlock => block.type === 'tool_use') : [];
};

const findToolResult = (messages: ClaudeMessage[]) => (toolUseId?: string): ToolResultBlock | null => {
  for (const message of messages) {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') continue;
    const content = raw.content ?? raw.message?.content;
    if (!Array.isArray(content)) continue;
    const result = content.find((block): block is ToolResultBlock => block.type === 'tool_result' && block.tool_use_id === toolUseId);
    if (result) return result;
  }
  return null;
};

const getToolResultRaw = (messages: ClaudeMessage[]) => (toolUseId: string) => {
  for (const message of messages) {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') continue;
    const content = raw.content ?? raw.message?.content;
    if (Array.isArray(content) && content.some((block) => block.type === 'tool_result' && (block as ToolResultBlock).tool_use_id === toolUseId)) {
      return raw as Record<string, unknown>;
    }
  }
  return null;
};

describe('extractSubagentsFromMessages', () => {
  it('retains Codex spawn_agent path metadata for history requests', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: '',
      raw: {
        message: {
          content: [{
            type: 'tool_use',
            id: 'call-spawn',
            name: 'spawn_agent',
            input: { task_name: 'audit_ui', message: 'Review anchors' },
          }],
        },
      },
    };

    const subagents = extractSubagentsFromMessages(
      [message], getContentBlocks, findToolResult([message]), getToolResultRaw([message]),
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'call-spawn',
      type: 'audit_ui',
      agentPath: 'audit_ui',
      isAsync: true,
      status: 'running',
    });
    expect(subagents[0].description).toBe('');
    expect(subagents[0].prompt).toBeUndefined();
  });

  it('does not expose Codex spawn_agent message content in StatusPanel fields', () => {
    const opaqueMessage = 'gAAAAABopaque-transport-content';
    const message: ClaudeMessage = {
      type: 'assistant',
      content: '',
      raw: {
        message: {
          content: [{
            type: 'tool_use',
            id: 'call-safe-spawn',
            name: 'spawn_agent',
            input: { task_name: '/root/reviewer', message: opaqueMessage },
          }],
        },
      },
    };

    const [subagent] = extractSubagentsFromMessages(
      [message], getContentBlocks, findToolResult([message]), getToolResultRaw([message]),
    );

    expect(subagent).toMatchObject({ type: 'reviewer', description: '', agentPath: '/root/reviewer' });
    expect(subagent.prompt).toBeUndefined();
    expect(JSON.stringify(subagent)).not.toContain(opaqueMessage);
  });

  it('filters only empty spawn_agent argument parsing noise', () => {
    const messages: ClaudeMessage[] = [{
      type: 'assistant',
      content: '',
      raw: {
        message: {
          content: [{ type: 'tool_use', id: 'call-invalid-spawn', name: 'spawn_agent', input: {} }],
        },
      },
    }, {
      type: 'user',
      content: '',
      raw: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-invalid-spawn',
          content: 'failed to parse function arguments: EOF while parsing a value',
        }],
      },
    }];

    expect(extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    )).toEqual([]);
  });

  it('retains a valid spawn_agent request that fails at runtime', () => {
    const messages: ClaudeMessage[] = [{
      type: 'assistant',
      content: '',
      raw: {
        message: {
          content: [{
            type: 'tool_use',
            id: 'call-valid-failure',
            name: 'spawn_agent',
            input: { task_name: 'reviewer', message: 'opaque' },
          }],
        },
      },
    }, {
      type: 'user',
      content: '',
      raw: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-valid-failure',
          content: 'permission denied while starting agent',
          is_error: true,
        }],
      },
    }];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({ type: 'reviewer', status: 'error' });
  });

  it('attaches completed Agent result metadata including stable agent id', () => {
    const messages = [assistantWithAgent('tooluse_backend'), toolResultMessage('tooluse_backend')];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'tooluse_backend',
      agentId: 'af5a83aa15ca39691',
      type: 'research',
      description: '分析后端历史索引服务的设计模式',
      status: 'completed',
      totalDurationMs: 62629,
      totalTokens: 110586,
      totalToolUseCount: 4,
    });
    expect(subagents[0].toolStats).toMatchObject({ readCount: 4 });
  });

  const assistantWithAsyncAgent = (toolUseId: string): ClaudeMessage => ({
    type: 'assistant',
    content: '',
    raw: {
      message: {
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Agent',
            input: {
              subagent_type: 'research',
              description: '后台调研 subagent',
              prompt: '调研索引服务设计模式',
              run_in_background: true,
            },
          },
        ],
      },
    },
  });

  // Async agent (Agent tool with run_in_background:true) only gets a launch
  // acknowledgment tool_result; the terminal status arrives later via a
  // task_notification event.
  const launchAckResult = (toolUseId: string): ClaudeMessage => ({
    type: 'user',
    content: '',
    raw: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'Async agent launched successfully.',
        },
      ],
    } as any,
  });

  it('keeps async agent running while only the launch ack has landed', () => {
    const messages = [assistantWithAsyncAgent('tu_spawn'), launchAckResult('tu_spawn')];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), {},
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].status).toBe('running');
  });

  it('completes async agent from its task_notification with event-derived metadata', () => {
    const messages = [assistantWithAsyncAgent('tu_spawn'), launchAckResult('tu_spawn')];
    const taskEvents = {
      tu_spawn: {
        toolUseId: 'tu_spawn',
        status: 'completed' as const,
        summary: '后台调研完成,发现 3 处索引模式',
        totalTokens: 4200,
        totalToolUseCount: 7,
        totalDurationMs: 18000,
      },
    };

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), taskEvents,
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'tu_spawn',
      status: 'completed',
      resultText: '后台调研完成,发现 3 处索引模式',
      totalTokens: 4200,
      totalToolUseCount: 7,
      totalDurationMs: 18000,
    });
  });

  it('marks async agent as error when task_notification reports failure', () => {
    const messages = [assistantWithAsyncAgent('tu_spawn')];
    const taskEvents = {
      tu_spawn: { toolUseId: 'tu_spawn', status: 'failed' as const },
    };

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), taskEvents,
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].status).toBe('error');
  });

  it('marks a failed async launch as error when the ack tool_result is is_error', () => {
    // A validation failure (e.g. "In-process teammates cannot spawn background
    // agents") returns an is_error tool_result before the background task is
    // registered, so no task_notification ever follows - the agent must surface
    // as error, not stay stuck on "running".
    const messages: ClaudeMessage[] = [
      assistantWithAsyncAgent('tu_launch_fail'),
      {
        type: 'user',
        content: '',
        raw: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_launch_fail',
              content: 'In-process teammates cannot spawn background agents',
              is_error: true,
            },
          ],
        } as any,
      },
    ];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), {},
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].status).toBe('error');
  });

  it('finalizes only async agents whose sidechain history ends in end_turn', () => {
    const messages = [assistantWithAsyncAgent('tu_spawn'), launchAckResult('tu_spawn')];
    const extracted = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), {},
    );

    expect(applySubagentHistoryCompletion(extracted, {
      tu_spawn: { success: true, completed: false, messages: [] },
    })[0].status).toBe('running');

    expect(applySubagentHistoryCompletion(extracted, {
      tu_spawn: { success: true, completed: true, messages: [] },
    })[0].status).toBe('completed');
  });

  it('flips to error only on an authoritatively observed sidechain failure', () => {
    const messages = [assistantWithAsyncAgent('tu_spawn'), launchAckResult('tu_spawn')];
    const extracted = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), {},
    );

    // Transient resolution/read failures (success === false) must keep the
    // agent running so polling can correct them.
    expect(applySubagentHistoryCompletion(extracted, {
      tu_spawn: { success: false, status: 'error', error: 'Read timed out' },
    })[0].status).toBe('running');

    // The backend read the sidechain and saw the turn abort: terminal error.
    expect(applySubagentHistoryCompletion(extracted, {
      tu_spawn: { success: true, status: 'error', error: 'Codex subagent turn was aborted' },
    })[0].status).toBe('error');
  });

  it('does not overwrite a task_notification error with sidechain completion', () => {const messages = [assistantWithAsyncAgent('tu_spawn')];
    const taskEvents = {
      tu_spawn: { toolUseId: 'tu_spawn', status: 'failed' as const },
    };
    const extracted = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), taskEvents,
    );

    expect(applySubagentHistoryCompletion(extracted, {
      tu_spawn: { success: true, completed: true, messages: [] },
    })[0].status).toBe('error');
  });
});
