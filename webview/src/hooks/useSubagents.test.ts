import { describe, expect, it } from 'vitest';
import { extractSubagentsFromMessages } from './useSubagents';
import { finalizeSubagentsForSettledTurn } from '../utils/turnScope';
import type { ClaudeContentBlock, ClaudeMessage, ClaudeRawMessage, ToolResultBlock } from '../types';

const noopGetToolResultRaw = () => null;

const assistantWithTool = (id: string, name: string, input: Record<string, unknown>): ClaudeMessage => ({
  type: 'assistant',
  content: '',
  timestamp: new Date().toISOString(),
  raw: {},
  blocks: [{ type: 'tool_use', id, name, input } as ClaudeContentBlock],
} as ClaudeMessage);

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

const successResult = (toolUseId: string, content = 'ok'): ToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content,
  is_error: false,
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
  if ((message as any).blocks) return (message as any).blocks as ClaudeContentBlock[];
  const raw = message.raw;
  if (!raw || typeof raw === 'string') return [];
  const content = raw.message?.content ?? raw.content;
  return Array.isArray(content) ? content.filter((block): block is ClaudeContentBlock => block.type === 'tool_use') : [];
};

const findToolResult = (messages: ClaudeMessage[], results?: Map<string, ToolResultBlock>) => (toolUseId?: string): ToolResultBlock | null => {
  if (toolUseId && results?.has(toolUseId)) return results.get(toolUseId) ?? null;
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

const getToolResultRaw = (messages: ClaudeMessage[]) => (toolUseId: string): ClaudeRawMessage | null => {
  for (const message of messages) {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') continue;
    const content = raw.content ?? raw.message?.content;
    if (Array.isArray(content) && content.some((block) => block.type === 'tool_result' && (block as ToolResultBlock).tool_use_id === toolUseId)) {
      return raw;
    }
  }
  return null;
};

describe('useSubagents lifecycle extraction', () => {
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
      provider: 'claude',
      totalDurationMs: 62629,
      totalTokens: 110586,
      totalToolUseCount: 4,
    });
    expect(subagents[0].toolStats).toMatchObject({ readCount: 4 });
  });

  it('keeps successful Codex spawn running until wait or close completes', () => {
    const messages = [assistantWithTool('spawn-1', 'spawn_agent', { message: 'work' })];
    const results = new Map<string, ToolResultBlock>([
      ['spawn-1', successResult('spawn-1', JSON.stringify({ agent_id: 'agent-1' }))],
    ]);

    const subagents = extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult(messages, results),
      noopGetToolResultRaw,
    );
    const finalized = finalizeSubagentsForSettledTurn(subagents, false);

    expect(finalized).toHaveLength(1);
    expect(finalized[0].provider).toBe('codex');
    expect(finalized[0].agentHandle).toBe('agent-1');
    expect(finalized[0].status).toBe('running');
  });

  it('marks Codex spawn completed when wait_agent completes for the same handle', () => {
    const messages = [
      assistantWithTool('spawn-1', 'spawn_agent', { message: 'work' }),
      assistantWithTool('wait-1', 'wait_agent', { targets: ['agent-1'] }),
    ];
    const results = new Map<string, ToolResultBlock>([
      ['spawn-1', successResult('spawn-1', JSON.stringify({ agent_id: 'agent-1' }))],
      ['wait-1', successResult('wait-1', JSON.stringify({ agent_id: 'agent-1', status: 'completed' }))],
    ]);

    const subagents = extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult(messages, results),
      noopGetToolResultRaw,
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].status).toBe('completed');
  });

  it('completes only the handle reported by wait_agent when multiple targets are provided', () => {
    const messages = [
      assistantWithTool('spawn-1', 'spawn_agent', { message: 'work 1' }),
      assistantWithTool('spawn-2', 'spawn_agent', { message: 'work 2' }),
      assistantWithTool('wait-1', 'wait_agent', { targets: ['agent-1', 'agent-2'] }),
    ];
    const results = new Map<string, ToolResultBlock>([
      ['spawn-1', successResult('spawn-1', JSON.stringify({ agent_id: 'agent-1' }))],
      ['spawn-2', successResult('spawn-2', JSON.stringify({ agent_id: 'agent-2' }))],
      ['wait-1', successResult('wait-1', JSON.stringify({ agent_id: 'agent-2', status: 'completed' }))],
    ]);

    const subagents = extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult(messages, results),
      noopGetToolResultRaw,
    );

    expect(subagents).toHaveLength(2);
    expect(subagents.find((subagent) => subagent.agentHandle === 'agent-1')?.status).toBe('running');
    expect(subagents.find((subagent) => subagent.agentHandle === 'agent-2')?.status).toBe('completed');
  });

  it('does not guess a completed handle from multi-target wait_agent without result identity', () => {
    const messages = [
      assistantWithTool('spawn-1', 'spawn_agent', { message: 'work 1' }),
      assistantWithTool('spawn-2', 'spawn_agent', { message: 'work 2' }),
      assistantWithTool('wait-1', 'wait_agent', { targets: ['agent-1', 'agent-2'] }),
    ];
    const results = new Map<string, ToolResultBlock>([
      ['spawn-1', successResult('spawn-1', JSON.stringify({ agent_id: 'agent-1' }))],
      ['spawn-2', successResult('spawn-2', JSON.stringify({ agent_id: 'agent-2' }))],
      ['wait-1', successResult('wait-1', JSON.stringify({ targets: ['agent-1', 'agent-2'] }))],
    ]);

    const subagents = extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult(messages, results),
      noopGetToolResultRaw,
    );

    expect(subagents).toHaveLength(2);
    expect(subagents.every((subagent) => subagent.status === 'running')).toBe(true);
  });

  it('uses send_input target instead of generic result text as Codex handle', () => {
    const messages = [assistantWithTool('send-1', 'send_input', { target: 'agent-1', message: 'continue' })];
    const results = new Map<string, ToolResultBlock>([
      ['send-1', successResult('send-1', 'ok')],
    ]);

    const subagents = extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult(messages, results),
      noopGetToolResultRaw,
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].agentHandle).toBe('agent-1');
    expect(subagents[0].status).toBe('running');
  });

  it('marks Codex spawn result without a plausible handle as error instead of running', () => {
    const messages = [assistantWithTool('spawn-invalid', 'spawn_agent', { message: 'work' })];
    const results = new Map<string, ToolResultBlock>([
      ['spawn-invalid', successResult('spawn-invalid', 'Full-history forked agents inherit the parent agent type, model, and reasoning effort; omit agent_type, model, and reasoning_effort.')],
    ]);

    const subagents = extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult(messages, results),
      noopGetToolResultRaw,
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0].agentHandle).toBeUndefined();
    expect(subagents[0].status).toBe('error');
  });
});
