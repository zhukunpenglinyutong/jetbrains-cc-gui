import { describe, expect, it } from 'vitest';
import type { ToolResultBlock } from '../types';
import {
  extractResultText,
  hasSubagentTranscript,
  isAsyncAgentInput,
  isSpawnAgentArgumentFailureNoise,
  parseAgentToolMeta,
  parseSpawnAgentMeta,
  readToolUseStatus,
} from './subagentResult';

describe('isAsyncAgentInput', () => {
  it('returns true for run_in_background: true (snake_case)', () => {
    expect(isAsyncAgentInput({ run_in_background: true })).toBe(true);
  });

  it('returns true for runInBackground: true (camelCase guard)', () => {
    expect(isAsyncAgentInput({ runInBackground: true })).toBe(true);
  });

  it('returns false for run_in_background: false', () => {
    expect(isAsyncAgentInput({ run_in_background: false })).toBe(false);
  });

  it('returns false for truthy non-boolean values (strict === true)', () => {
    // A string like "false" must not flip the flag - this is the regression
    // the strict === true check exists to prevent.
    expect(isAsyncAgentInput({ run_in_background: 'false' })).toBe(false);
    expect(isAsyncAgentInput({ run_in_background: 'true' })).toBe(false);
    expect(isAsyncAgentInput({ run_in_background: 1 })).toBe(false);
  });

  it('returns false when the field is absent', () => {
    expect(isAsyncAgentInput({ prompt: 'do stuff' })).toBe(false);
  });

  it('returns false for non-object / nullish input', () => {
    expect(isAsyncAgentInput(null)).toBe(false);
    expect(isAsyncAgentInput(undefined)).toBe(false);
    expect(isAsyncAgentInput('not-an-object')).toBe(false);
    expect(isAsyncAgentInput(42)).toBe(false);
  });

  it('treats Codex spawn_agent as asynchronous without a background flag', () => {
    expect(isAsyncAgentInput({ task_name: 'audit_ui' }, 'spawn_agent')).toBe(true);
    expect(isAsyncAgentInput({ task_name: 'audit_ui' }, 'functions.spawn_agent')).toBe(true);
  });

  it('returns true when the launch ack text indicates async', () => {
    // Claude stamps the async launch ack with a fixed "Async agent launched"
    // text; matching it keeps a background agent (whose input may lack
    // run_in_background) from being marked completed the instant the ack lands.
    const result: ToolResultBlock = { type: 'tool_result', content: 'Async agent launched successfully. (internal metadata)' };
    expect(isAsyncAgentInput({ prompt: 'do stuff' }, 'agent', result)).toBe(true);
  });

  it('returns true for launch ack text supplied as content blocks', () => {
    const result: ToolResultBlock = { type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.' }] };
    expect(isAsyncAgentInput({ description: 'x' }, 'agent', result)).toBe(true);
  });

  it('does not false-positive on a sync result that merely mentions async', () => {
    const result: ToolResultBlock = { type: 'tool_result', content: 'Refactored the async handler and landed the fix.' };
    expect(isAsyncAgentInput({ prompt: 'x' }, 'agent', result)).toBe(false);
  });

  it('returns true for an async tool-use status even without run_in_background', () => {
    expect(isAsyncAgentInput({ prompt: 'x' }, 'agent', null, 'async_launched')).toBe(true);
    expect(isAsyncAgentInput({ prompt: 'x' }, 'agent', null, 'remote_launched')).toBe(true);
    expect(isAsyncAgentInput({ prompt: 'x' }, 'agent', null, 'teammate_spawned')).toBe(true);
  });

  it('returns false for a completed tool-use status (sync agent)', () => {
    expect(isAsyncAgentInput({ prompt: 'x' }, 'agent', null, 'completed')).toBe(false);
    expect(isAsyncAgentInput({ prompt: 'x' }, 'agent', null, 'running')).toBe(false);
  });
});

describe('readToolUseStatus', () => {
  it('reads status from toolUseResult metadata', () => {
    expect(readToolUseStatus({ toolUseResult: { status: 'async_launched', agentId: 'x' } })).toBe('async_launched');
  });

  it('returns undefined when toolUseResult is missing or non-object', () => {
    expect(readToolUseStatus({ content: 'x' })).toBeUndefined();
    expect(readToolUseStatus(null)).toBeUndefined();
    expect(readToolUseStatus(undefined)).toBeUndefined();
    expect(readToolUseStatus({ toolUseResult: 'error string' })).toBeUndefined();
    expect(readToolUseStatus({ toolUseResult: null })).toBeUndefined();
    expect(readToolUseStatus({ toolUseResult: [] })).toBeUndefined();
  });
});

describe('parseSpawnAgentMeta', () => {
  it('uses Codex task_name as the stable agent path', () => {
    expect(parseSpawnAgentMeta({
      task_name: 'audit_ui',
      model: 'gpt-5.6-terra',
      reasoning_effort: 'high',
    })).toEqual({
      agentPath: 'audit_ui',
      identityLabel: 'audit_ui',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
    });
  });

  it('keeps Claude agent_id and description metadata', () => {
    expect(parseSpawnAgentMeta({
      agent_id: 'agent-123',
      description: 'Review the bridge',
    })).toEqual({
      agentId: 'agent-123',
      description: 'Review the bridge',
    });
  });

  it('prefers nickname and otherwise uses the final task path segment for display identity', () => {
    expect(parseSpawnAgentMeta({ task_name: '/root/reviewer' })).toMatchObject({
      agentPath: '/root/reviewer',
      identityLabel: 'reviewer',
    });
    expect(parseSpawnAgentMeta({ task_name: '/root/reviewer', nickname: 'Hilbert' })).toMatchObject({
      identityLabel: 'Hilbert',
      nickname: 'Hilbert',
    });
  });
});

describe('isSpawnAgentArgumentFailureNoise', () => {
  it('identifies empty historical calls with explicit argument parsing failures', () => {
    expect(isSpawnAgentArgumentFailureNoise({}, {
      type: 'tool_result',
      content: 'failed to parse function arguments: EOF while parsing a value',
    })).toBe(true);
  });

  it('keeps valid launches and unrelated runtime errors visible', () => {
    const parseFailure = {
      type: 'tool_result' as const,
      content: 'failed to parse function arguments: missing field task_name',
      is_error: true,
    };
    expect(isSpawnAgentArgumentFailureNoise({ task_name: 'reviewer' }, parseFailure)).toBe(false);
    expect(isSpawnAgentArgumentFailureNoise({}, {
      type: 'tool_result',
      content: 'permission denied while starting agent',
      is_error: true,
    })).toBe(false);
  });
});

describe('hasSubagentTranscript', () => {
  it('distinguishes lightweight status from a loaded transcript', () => {
    expect(hasSubagentTranscript({})).toBe(false);
    expect(hasSubagentTranscript({ messages: [] })).toBe(true);
  });
});

describe('extractResultText', () => {
  it('returns undefined for no result', () => {
    expect(extractResultText(undefined)).toBeUndefined();
    expect(extractResultText(null)).toBeUndefined();
  });

  it('returns string content directly', () => {
    expect(extractResultText({ type: 'tool_result', content: 'done' })).toBe('done');
  });

  it('joins text blocks from array content', () => {
    expect(
      extractResultText({
        type: 'tool_result',
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      }),
    ).toBe('a\nb');
  });

  it('returns undefined for empty/whitespace-only text', () => {
    expect(
      extractResultText({ type: 'tool_result', content: [{ type: 'text', text: '' }] }),
    ).toBeUndefined();
  });

  it('returns undefined when content has no text blocks', () => {
    expect(extractResultText({ type: 'tool_result', content: [{ type: 'image' }] })).toBeUndefined();
  });
});

describe('parseAgentToolMeta', () => {
  it('returns empty object when toolUseId is missing', () => {
    expect(parseAgentToolMeta(() => null)).toEqual({});
  });

  it('returns empty object when raw has no toolUseResult', () => {
    const getter = () => ({ content: 'x' });
    expect(parseAgentToolMeta(getter, 'tu_1')).toEqual({});
  });

  it('extracts agentId/usage metadata from toolUseResult', () => {
    const getter = () => ({
      toolUseResult: {
        agentId: 'af5a83aa',
        totalDurationMs: 18000,
        totalTokens: 4200,
        totalToolUseCount: 7,
      },
    });
    expect(parseAgentToolMeta(getter, 'tu_1')).toEqual({
      agentId: 'af5a83aa',
      totalDurationMs: 18000,
      totalTokens: 4200,
      totalToolUseCount: 7,
    });
  });

  it('ignores non-object toolUseResult (e.g. raw error string)', () => {
    // The SDK may overwrite toolUseResult with a raw error string; the helper
    // must fall back to {} rather than reading properties off a string.
    const getter = () => ({ toolUseResult: 'some error string' });
    expect(parseAgentToolMeta(getter, 'tu_1')).toEqual({});
  });

  it('ignores non-finite / wrong-typed numeric fields', () => {
    const getter = () => ({
      toolUseResult: { totalTokens: NaN, totalDurationMs: Infinity, totalToolUseCount: '7' },
    });
    expect(parseAgentToolMeta(getter, 'tu_1')).toEqual({});
  });
});
