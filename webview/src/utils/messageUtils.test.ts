import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import { getMessageKey, getContentBlocks, mergeConsecutiveAssistantMessages, normalizeBlocks, findToolResultBlock } from './messageUtils';

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

const normalizeRenderableBlocks = (raw: unknown): any[] => {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as any;
  const blocks = r.content ?? r.message?.content;
  return Array.isArray(blocks) ? blocks : [];
};

const buildKeyFallbackMessage = (content: string, extra?: Partial<ClaudeMessage>): ClaudeMessage => ({
  type: 'assistant',
  content,
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

  it('returns stable turn key when uuid is absent and message has merged raw blocks', () => {
    const ts = '2024-01-01T00:00:00Z';
    const msg = makeMsg('assistant', 'hello', {
      __turnId: 3,
      timestamp: ts,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'plan' },
            { type: 'tool_use', id: 'tool-1', name: 'Read' },
          ],
        },
      } as any,
    });
    expect(getMessageKey(msg, 0)).toBe('turn-3');
  });

  it('returns same key for same __turnId even when timestamps differ', () => {
    const a = makeMsg('assistant', 'hello', { __turnId: 3, timestamp: '2024-01-01T00:00:00Z' });
    const b = makeMsg('assistant', 'hello again', { __turnId: 3, timestamp: '2024-01-01T00:00:01Z' });
    expect(getMessageKey(a, 0)).toBe(getMessageKey(b, 1));
  });

  it('returns stable __turnId key when timestamp is absent', () => {
    const msg: ClaudeMessage = { type: 'assistant', content: 'hi', __turnId: 7 };
    expect(getMessageKey(msg, 2)).toBe('turn-7');
  });

  it('falls back to type-timestamp when uuid is not a string', () => {
    const ts = '2024-01-01T00:00:00Z';
    const msg = makeMsg('user', 'hello', { raw: { uuid: 123 } as any, timestamp: ts });
    expect(getMessageKey(msg, 0)).toBe(`user-${ts}`);
  });

  it('falls back to a content signature plus index when no uuid, __turnId, or timestamp', () => {
    const msg = buildKeyFallbackMessage('hi');
    expect(getMessageKey(msg, 7)).toBe('assistant-hi-7');
  });

  it('returns different fallback keys for equivalent content at different indexes without stable identity', () => {
    const raw = { message: { content: [{ type: 'text', text: 'same text' }] } } as any;
    const a = buildKeyFallbackMessage('', { raw });
    const b = buildKeyFallbackMessage('', { raw });
    expect(getMessageKey(a, 1)).not.toBe(getMessageKey(b, 99));
  });

  it('prefers __renderKey for messages lacking persistent identity', () => {
    const msg = buildKeyFallbackMessage('hi', { __renderKey: 'merged-assistant-key' });
    expect(getMessageKey(msg, 7)).toBe('merged-assistant-key');
  });
});

// ---------------------------------------------------------------------------
// mergeConsecutiveAssistantMessages — __turnId preservation
// ---------------------------------------------------------------------------

describe('mergeConsecutiveAssistantMessages', () => {
  it('does not merge adjacent assistant messages when turn IDs differ', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        __turnId: 1,
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeRenderableBlocks as any);
    expect(result).toHaveLength(2);
    expect(result[0].__turnId).toBe(1);
    expect(result[1].__turnId).toBe(2);
  });

  it('does not merge adjacent assistant messages when turn ID is missing on one side and the other side has a turn ID', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeRenderableBlocks as any);
    expect(result).toHaveLength(2);
  });

  it('merges adjacent assistant messages with the same turn ID even when tool_use blocks are present', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'tool phase', {
        __turnId: 7,
        raw: {
          content: [
            { type: 'text', text: 'tool phase' },
            { type: 'tool_use', id: 'tool-1', name: 'Skill' },
          ],
        } as any,
      }),
      makeMsg('assistant', 'final answer', {
        __turnId: 7,
        raw: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            { type: 'text', text: 'final answer' },
          ],
        } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeRenderableBlocks as any);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBe(7);
    expect(result[0].content).toBe('tool phase\nfinal answer');
    expect((result[0].raw as any)?.message?.content).toEqual([
      { type: 'text', text: 'tool phase' },
      { type: 'tool_use', id: 'tool-1', name: 'Skill' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('merges adjacent assistant messages without turn IDs when they are consecutive renderable assistant fragments', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        raw: { content: [{ type: 'thinking', thinking: 'reasoning' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'final answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeRenderableBlocks as any);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBeUndefined();
    expect((result[0].raw as any)?.message?.content).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('does not merge adjacent assistant messages without turn IDs when they only contain plain text', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'first answer', {
        raw: { content: [{ type: 'text', text: 'first answer' }] } as any,
      }),
      makeMsg('assistant', 'second answer', {
        raw: { content: [{ type: 'text', text: 'second answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeRenderableBlocks as any);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('first answer');
    expect(result[1].content).toBe('second answer');
  });

  it('records a lightweight source range for merged assistant messages', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        raw: { content: [{ type: 'thinking', thinking: 'reasoning' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'final answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeRenderableBlocks as any);
    expect(result).toHaveLength(1);
    expect(result[0].__sourceRange).toEqual({ start: 0, end: 1 });
    expect(result[0].__sourceRange).not.toHaveProperty('length');
    expect(result[0].__renderKey).toContain('#2');
  });

  it('does not merge adjacent streaming assistant messages even when turn IDs match', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'thinking phase', {
        __turnId: 9,
        isStreaming: true,
        raw: { content: [{ type: 'thinking', thinking: 'first thought' }] } as any,
      }),
      makeMsg('assistant', 'tool phase', {
        __turnId: 9,
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeRenderableBlocks as any);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('thinking phase');
    expect(result[1].content).toBe('tool phase');
  });
});

describe('findToolResultBlock', () => {
  it('prefers tool results from the same turn after the anchor message', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'previous tool', {
        __turnId: 1,
        raw: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] } } as any,
      }),
      makeMsg('user', 'previous result', {
        __turnId: 1,
        raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'old result' }] } } as any,
      }),
      makeMsg('assistant', 'current tool', {
        __turnId: 2,
        raw: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] } } as any,
      }),
      makeMsg('user', 'current result', {
        __turnId: 2,
        raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'new result' }] } } as any,
      }),
    ];

    expect(findToolResultBlock(messages, 'tool-1', 2)?.content).toBe('new result');
  });

  it('falls back to the direct raw message index when anchor has no uuid or turn id but the raw object matches', () => {
    const rawMessage = makeMsg('assistant', 'tool call', {
      raw: { message: { content: [{ type: 'tool_use', id: 'tool-2', name: 'Read' }] } } as any,
    });
    const rawMessages: ClaudeMessage[] = [
      rawMessage,
      makeMsg('user', 'tool result holder', {
        raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'matched' }] } } as any,
      }),
    ];
    const renderedAssistant: ClaudeMessage = {
      type: 'assistant',
      content: 'tool call',
      raw: rawMessage.raw,
    };

    expect(findToolResultBlock(rawMessages, 'tool-2', 0, renderedAssistant)?.content).toBe('matched');
  });

  it('uses source range over message index when resolving merged history tool results', () => {
    const rawMessages: ClaudeMessage[] = [
      makeMsg('user', 'earlier user'),
      makeMsg('assistant', 'thinking fragment', {
        raw: { message: { content: [{ type: 'thinking', thinking: 'plan' }] } } as any,
      }),
      makeMsg('assistant', 'tool fragment', {
        raw: { message: { content: [{ type: 'tool_use', id: 'tool-10', name: 'Read' }] } } as any,
      }),
      makeMsg('user', 'tool result holder', {
        raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-10', content: 'ok-10' }] } } as any,
      }),
    ];

    const renderedAssistant: ClaudeMessage = {
      type: 'assistant',
      content: 'thinking fragment\ntool fragment',
      __sourceRange: { start: 1, end: 2 },
      raw: rawMessages[1].raw,
    };

    expect(findToolResultBlock(rawMessages, 'tool-10', 0, renderedAssistant)?.content).toBe('ok-10');
  });


  it('resolves tool results for merged history assistants via __sourceRange when turn id and uuid are absent', () => {
    const assistantThinking = makeMsg('assistant', 'thinking fragment', {
      raw: { message: { content: [{ type: 'thinking', thinking: 'plan' }] } } as any,
    });
    const assistantTool = makeMsg('assistant', 'tool fragment', {
      raw: { message: { content: [{ type: 'tool_use', id: 'tool-9', name: 'Read' }] } } as any,
    });
    const rawMessages: ClaudeMessage[] = [
      assistantThinking,
      assistantTool,
      makeMsg('user', 'tool result holder', {
        raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-9', content: 'ok' }] } } as any,
      }),
    ];

    const merged = mergeConsecutiveAssistantMessages(rawMessages, normalizeRenderableBlocks);

    expect(merged).toHaveLength(2);
    const renderedAssistant = merged[0];
    expect(renderedAssistant.__sourceRange).toEqual({ start: 0, end: 1 });
    expect(findToolResultBlock(rawMessages, 'tool-9', 0, renderedAssistant)?.content).toBe('ok');
  });
  const localizeMessage = (text: string) => text;

  it('appends final assistant text after tool_use blocks when normalized raw has no text block', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'final answer',
      raw: {
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Skill' },
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
          ],
        },
      } as any,
    };

    const normalized = normalizeBlocks(message.raw as any, localizeMessage, ((key: string) => key) as any);
    expect(normalized).toEqual([
      { type: 'tool_use', id: 'tool-1', name: 'Skill', input: {} },
    ]);

    const blocks = getContentBlocks(message, (raw) => normalizeBlocks(raw as any, localizeMessage, ((key: string) => key) as any), localizeMessage);
    expect(blocks).toEqual([
      { type: 'tool_use', id: 'tool-1', name: 'Skill', input: {} },
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('preserves raw text order when text already follows a tool block', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      raw: {
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Skill' },
            { type: 'text', text: 'final answer' },
          ],
        },
      } as any,
    };

    const blocks = getContentBlocks(message, (raw) => normalizeBlocks(raw as any, localizeMessage, ((key: string) => key) as any), localizeMessage);
    expect(blocks).toEqual([
      { type: 'tool_use', id: 'tool-1', name: 'Skill', input: {} },
      { type: 'text', text: 'final answer' },
    ]);
  });
});
