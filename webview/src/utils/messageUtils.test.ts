import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import { getMessageKey, mergeConsecutiveAssistantMessages } from './messageUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMsg = (
  type: ClaudeMessage['type'],
  content: string,
  extra?: Partial<ClaudeMessage>,
): ClaudeMessage => ({
  type,
  content,
  timestamp: new Date().toISOString(),
  ...extra,
});

// ---------------------------------------------------------------------------
// getMessageKey — __turnId support
// ---------------------------------------------------------------------------

describe('getMessageKey', () => {
  it('returns uuid when present', () => {
    const msg = makeMsg('assistant', 'hello', { raw: { uuid: 'abc-123' } as any });
    expect(getMessageKey(msg, 0)).toBe('abc-123');
  });

  it('returns uuid even when __turnId is also present', () => {
    const msg = makeMsg('assistant', 'hello', {
      raw: { uuid: 'abc-123' } as any,
      __turnId: 5,
    });
    expect(getMessageKey(msg, 0)).toBe('abc-123');
  });

  it('returns __turnId-based key when uuid is absent', () => {
    const msg = makeMsg('assistant', 'hello', { __turnId: 3 });
    expect(getMessageKey(msg, 0)).toBe('turn-3');
  });

  it('falls back to type-timestamp when both uuid and __turnId are absent', () => {
    const ts = '2024-01-01T00:00:00Z';
    const msg = makeMsg('user', 'hello', { timestamp: ts });
    expect(getMessageKey(msg, 0)).toBe(`user-${ts}`);
  });

  it('falls back to type-index when no uuid, __turnId, or timestamp', () => {
    const msg: ClaudeMessage = { type: 'assistant', content: 'hi' };
    expect(getMessageKey(msg, 7)).toBe('assistant-7');
  });
});

// ---------------------------------------------------------------------------
// mergeConsecutiveAssistantMessages — __turnId preservation
// ---------------------------------------------------------------------------

describe('mergeConsecutiveAssistantMessages', () => {
  const normalizeBlocks = (raw: unknown): any[] => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as any;
    const blocks = r.content ?? r.message?.content;
    return Array.isArray(blocks) ? blocks : [];
  };

  it('preserves __turnId from first message in merged group', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBe(2);
  });

  it('does not add __turnId when first message has none', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBeUndefined();
  });

  it('does not merge across user messages', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'a1', { __turnId: 1 }),
      makeMsg('user', 'q'),
      makeMsg('assistant', 'a2', { __turnId: 2 }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(3);
    expect(result[0].__turnId).toBe(1);
    expect(result[2].__turnId).toBe(2);
  });

  it('does not merge assistant messages from different turns', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'first turn answer', {
        __turnId: 10,
        raw: { content: [{ type: 'text', text: 'first turn answer' }] } as any,
      }),
      makeMsg('assistant', 'second turn answer', {
        __turnId: 11,
        raw: { content: [{ type: 'text', text: 'second turn answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(2);
    expect(result.map((message) => message.__turnId)).toEqual([10, 11]);
  });

  it('does not merge streaming message (has __turnId) with history message (no __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'streaming turn', {
        __turnId: 5,
        raw: { content: [{ type: 'text', text: 'streaming turn' }] } as any,
      }),
      makeMsg('assistant', 'history message', {
        raw: { content: [{ type: 'text', text: 'history message' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(2);
    expect(result[0].__turnId).toBe(5);
    expect(result[1].__turnId).toBeUndefined();
  });

  it('does not merge history message (no __turnId) with streaming message (has __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'history message', {
        raw: { content: [{ type: 'text', text: 'history message' }] } as any,
      }),
      makeMsg('assistant', 'streaming turn', {
        __turnId: 5,
        raw: { content: [{ type: 'text', text: 'streaming turn' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(2);
    expect(result[0].__turnId).toBeUndefined();
    expect(result[1].__turnId).toBe(5);
  });

  it('merges history messages without __turnId together', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('part1\npart2');
  });

  it('merges tool-only assistant messages across user tool_result boundaries', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', '', {
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'git status' } }] } as any,
      }),
      makeMsg('user', '[tool_result]', {
        raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } as any,
      }),
      makeMsg('assistant', '', {
        raw: { content: [{ type: 'tool_use', id: 'tool-2', name: 'shell_command', input: { command: 'git diff --cached' } }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);

    expect(result).toHaveLength(1);
    const mergedRaw = result[0].raw as { content?: Array<{ type?: string; id?: string }> };
    expect(mergedRaw.content?.filter((block) => block.type === 'tool_use').map((block) => block.id)).toEqual(['tool-1', 'tool-2']);
  });

  // ---------------------------------------------------------------------------
  // hasToolUse + __turnId absence — tool_use merging behavior
  // ---------------------------------------------------------------------------

  it('merges tool_use with final answer for history messages (no __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', '', {
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file' }] } as any,
      }),
      makeMsg('user', '[tool_result]', {
        raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }] } as any,
      }),
      makeMsg('assistant', 'final answer', {
        raw: { content: [{ type: 'text', text: 'final answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    const mergedRaw = result[0].raw as { content?: Array<{ type?: string }> };
    expect(mergedRaw.content?.some((b) => b.type === 'tool_use')).toBe(true);
    expect(mergedRaw.content?.some((b) => b.type === 'text')).toBe(true);
  });

  it('keeps tool_use separated from final answer for streaming messages (has __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', '', {
        __turnId: 1,
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file' }] } as any,
      }),
      makeMsg('user', '[tool_result]', {
        raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }] } as any,
      }),
      makeMsg('assistant', 'final answer', {
        __turnId: 1,
        raw: { content: [{ type: 'text', text: 'final answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    // Should have 2 assistant messages: tool_use block and final answer block
    // (user tool_result is skipped, but assistant blocks stay separated)
    expect(result.filter((m) => m.type === 'assistant')).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Regression: single assistant + trailing tool_result user must not be dropped
  // Bug: i = j skipped intermediate tool_result-only user messages when
  // assistantGroup.length <= 1, causing mergedMessages to shrink and
  // preserveLatestMessagesOnShrink to re-append them as duplicates.
  // ---------------------------------------------------------------------------

  it('preserves tool_result user message when no second assistant follows (regression)', () => {
    const toolResultUser = makeMsg('user', '[tool_result]', {
      raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } as any,
    });
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'hello'),
      toolResultUser,
      makeMsg('user', 'follow-up'),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);

    expect(result).toHaveLength(3);
    expect(result[1]).toBe(toolResultUser);
    expect(result[2].type).toBe('user');
    expect(result[2].content).toBe('follow-up');
  });

  it('preserves tool_result user message at end of list when no second assistant follows', () => {
    const toolResultUser = makeMsg('user', '[tool_result]', {
      raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } as any,
    });
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'hello'),
      toolResultUser,
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);

    expect(result).toHaveLength(2);
    expect(result[1]).toBe(toolResultUser);
  });
});
