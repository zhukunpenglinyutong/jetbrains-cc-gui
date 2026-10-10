import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useMessageProcessing } from './useMessageProcessing.js';
import type { ClaudeMessage } from '../types/index.js';

const t = ((key: string) => key) as any;

const makeMessage = (
  type: ClaudeMessage['type'],
  content: string,
  extra?: Partial<ClaudeMessage>,
): ClaudeMessage => ({
  type,
  content,
  timestamp: new Date().toISOString(),
  ...extra,
});

describe('useMessageProcessing', () => {
  it('keeps native reasoning lifecycle metadata beside the same-turn answer', () => {
    const nativeRaw = { codexThreadId: 'native-thread', codexTurnId: 'native-turn', codexSnapshot: true };
    const messages: ClaudeMessage[] = [
      makeMessage('assistant', '', { raw: { ...nativeRaw, uuid: 'native-reasoning', codexItemType: 'reasoning',
        message: { content: [{ type: 'thinking', thinking: '', native: true, status: 'completed' }] } } }),
      makeMessage('assistant', 'Native answer', { raw: { ...nativeRaw, uuid: 'native-answer', codexItemType: 'agentMessage',
        message: { content: [{ type: 'text', text: 'Native answer' }] } } }),
    ];
    const { result } = renderHook(() => useMessageProcessing({ messages, currentSessionId: 'native-thread', t }));

    expect(result.current.mergedMessages).toHaveLength(1);
    expect(result.current.getContentBlocks(result.current.mergedMessages[0])).toEqual([
      { type: 'thinking', thinking: '', text: '', native: true, status: 'completed' },
      { type: 'text', text: 'Native answer' },
    ]);
  });

  it('hides empty native items without changing their raw lifecycle or identity', () => {
    const makeReasoning = (thinking: string, status: string): ClaudeMessage => makeMessage('assistant', '', {
      raw: { uuid: 'same-reasoning-item', codexThreadId: 'thread', codexTurnId: 'turn', codexItemType: 'reasoning',
        codexSnapshot: true, message: { content: [{ type: 'thinking', thinking, native: true, status }] } },
    });
    const started = makeReasoning('', 'inProgress');
    const { result, rerender } = renderHook(({ messages }) =>
      useMessageProcessing({ messages, currentSessionId: 'thread', t }), { initialProps: { messages: [started] } });
    expect(result.current.mergedMessages).toEqual([]);
    expect(started.raw).toMatchObject({ uuid: 'same-reasoning-item', message: {
      content: [{ type: 'thinking', thinking: '', native: true, status: 'inProgress' }],
    } });

    const streaming = makeReasoning('A public native summary', 'inProgress');
    rerender({ messages: [streaming] });
    expect(result.current.mergedMessages).toEqual([streaming]);

    const completed = makeReasoning('A public native summary', 'completed');
    rerender({ messages: [completed] });
    expect(result.current.mergedMessages).toEqual([completed]);

    rerender({ messages: [makeReasoning(' \n\t', 'completed')] });
    expect(result.current.mergedMessages).toEqual([]);
  });

  it('keeps visible reply text supplied beside an empty native item', () => {
    const message = makeMessage('assistant', 'The visible reply', { raw: {
      uuid: 'empty-native-with-reply', codexThreadId: 'thread', codexTurnId: 'turn',
      message: { content: [{ type: 'thinking', thinking: '', native: true, status: 'completed' }] },
    } });
    const { result } = renderHook(() => useMessageProcessing({ messages: [message], currentSessionId: 'thread', t }));
    expect(result.current.mergedMessages).toEqual([message]);
    expect(result.current.getContentBlocks(message).at(-1)).toEqual({ type: 'text', text: 'The visible reply' });
  });

  it('keeps summary-less native compaction boundaries between assistant fragments', () => {
    const messages = [makeMessage('assistant', 'before'),
      makeMessage('assistant', '', { raw: { uuid: 'cmp', isCompactSummary: true,
        summarizeMetadata: { native: true, status: 'completed', timestamp: 1_000, timestampSource: 'item' },
        message: { content: [{ type: 'text', text: '' }] } } }),
      makeMessage('assistant', 'after')];
    const { result } = renderHook(() => useMessageProcessing({ messages, currentSessionId: 't', t }));
    expect(result.current.mergedMessages.map((m) => m.type)).toEqual(['assistant', 'notification', 'assistant']);
    expect(result.current.getContentBlocks(result.current.mergedMessages[1])).toEqual([
      { type: 'compact_summary', title: 'chat.compactSummary.nativeCompleted', content: '',
        metadata: { native: true, status: 'completed', timestamp: 1_000, timestampSource: 'item' } },
    ]);
  });
  it('keeps assistant turns separate when a hidden message sits between them', () => {
    const messages: ClaudeMessage[] = [
      makeMessage('assistant', 'First assistant reply', {
        __turnId: 1,
        raw: { content: [{ type: 'text', text: 'First assistant reply' }] } as any,
        timestamp: '2026-04-01T10:00:00.000Z',
      }),
      makeMessage('user', '', {
        raw: '<command-name>/aimax:auto</command-name>\n<command-args>follow up</command-args>' as any,
        timestamp: '2026-04-01T10:00:01.000Z',
      }),
      makeMessage('assistant', 'Second assistant reply', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'Second assistant reply' }] } as any,
        timestamp: '2026-04-01T10:00:02.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useMessageProcessing({
        messages,
        currentSessionId: 'session-1',
        t,
      }),
    );

    expect(result.current.mergedMessages).toHaveLength(2);
    expect(result.current.mergedMessages.map((message) => message.content)).toEqual([
      'First assistant reply',
      'Second assistant reply',
    ]);
    expect(result.current.mergedMessages.map((message) => message.__turnId)).toEqual([1, 2]);
  });

  it('renders /compact as user message with summary notification', () => {
    const messages: ClaudeMessage[] = [
      // /compact command → stays as user message
      makeMessage('user', '', {
        raw: { message: { content: '<command-name>/compact</command-name><command-message>compact</command-message>' } },
        timestamp: '2026-01-01T10:00:00.000Z',
      }),
      // stdout → hidden (HIDDEN_OUTPUT_TAGS)
      makeMessage('user', '', {
        raw: { message: { content: '<local-command-stdout>Compacted Tip: test</local-command-stdout>' } },
        timestamp: '2026-01-01T10:00:01.000Z',
      }),
      // isCompactSummary → notification with collapsible compact_summary block
      makeMessage('user', '', {
        raw: { isCompactSummary: true, summarizeMetadata: { messagesSummarized: 10 }, message: { content: 'This session is being continued...' } },
        timestamp: '2026-01-01T10:00:02.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useMessageProcessing({ messages, currentSessionId: 'session-1', t }),
    );

    // /compact user message + summary notification
    expect(result.current.mergedMessages).toHaveLength(2);
    expect(result.current.mergedMessages[0].type).toBe('user');
    expect(result.current.mergedMessages[1].type).toBe('notification');
  });

  it('shows auto-compact summary as notification', () => {
    const messages: ClaudeMessage[] = [
      makeMessage('user', '', {
        raw: { isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation...' } },
        timestamp: '2026-01-01T10:00:00.000Z',
      }),
      makeMessage('assistant', 'Hello', {
        raw: { content: [{ type: 'text', text: 'Hello' }] } as any,
        timestamp: '2026-01-01T10:00:01.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useMessageProcessing({ messages, currentSessionId: 'session-1', t }),
    );

    expect(result.current.mergedMessages).toHaveLength(2);
    expect(result.current.mergedMessages[0].type).toBe('notification');
    expect(result.current.mergedMessages[1].type).toBe('assistant');
  });

  it('keeps standalone stdout hidden', () => {
    const messages: ClaudeMessage[] = [
      makeMessage('user', 'hello', { timestamp: '2026-01-01T10:00:00.000Z' }),
      makeMessage('user', '', {
        raw: { message: { content: '<local-command-stdout>orphan output</local-command-stdout>' } },
        timestamp: '2026-01-01T10:00:01.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useMessageProcessing({ messages, currentSessionId: 'session-1', t }),
    );

    // Standalone stdout should be hidden (only hello visible)
    expect(result.current.mergedMessages).toHaveLength(1);
    expect(result.current.mergedMessages[0].content).toBe('hello');
  });

  it('swaps order when isCompactSummary precedes /compact', () => {
    // Real CLI output: isCompactSummary is written before /compact in JSONL
    const messages: ClaudeMessage[] = [
      // isCompactSummary comes first in file order
      makeMessage('user', '', {
        raw: { isCompactSummary: true, summarizeMetadata: { messagesSummarized: 10 }, message: { content: 'Summary...' } },
        timestamp: '2026-01-01T10:00:02.000Z',
      }),
      // /compact command follows
      makeMessage('user', '', {
        raw: { message: { content: '<command-name>/compact</command-name><command-message>compact</command-message>' } },
        timestamp: '2026-01-01T10:00:00.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useMessageProcessing({ messages, currentSessionId: 'session-1', t }),
    );

    // /compact user message should be swapped before the summary notification
    expect(result.current.mergedMessages).toHaveLength(2);
    expect(result.current.mergedMessages[0].type).toBe('user');
    expect(result.current.mergedMessages[1].type).toBe('notification');
  });

  it('non-compact command with stdout remains hidden', () => {
    const messages: ClaudeMessage[] = [
      makeMessage('user', '', {
        raw: { message: { content: '<command-name>/aimax:auto</command-name><command-message>aimax:auto</command-message>' } },
        timestamp: '2026-01-01T10:00:00.000Z',
      }),
      makeMessage('user', '', {
        raw: { message: { content: '<local-command-stdout>some output</local-command-stdout>' } },
        timestamp: '2026-01-01T10:00:01.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useMessageProcessing({ messages, currentSessionId: 'session-1', t }),
    );

    // Non-compact command renders as user message, stdout hidden
    expect(result.current.mergedMessages).toHaveLength(1);
    expect(result.current.mergedMessages[0].type).toBe('user');
  });

  it('shows new user message once after compact command during streaming', () => {
    // Simulates backend response after compaction: compact command with XML
    // tags + stdout, followed by a new user message. Verifies no duplicate.
    const messages: ClaudeMessage[] = [
      makeMessage('user', '', {
        raw: { message: { content: '<command-name>/compact</command-name><command-message>compact</command-message>' } },
        timestamp: '2026-01-01T10:00:00.000Z',
      }),
      makeMessage('user', '', {
        raw: { message: { content: '<local-command-stdout>Compacted Tip: ...</local-command-stdout>' } },
        timestamp: '2026-01-01T10:00:01.000Z',
      }),
      makeMessage('user', 'hello', {
        raw: { message: { content: [{ type: 'text', text: 'hello' }] } },
        timestamp: '2026-01-01T10:00:02.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useMessageProcessing({ messages, currentSessionId: 'session-1', t }),
    );

    // /compact user message + user "hello" (no duplicate, stdout hidden)
    expect(result.current.mergedMessages).toHaveLength(2);
    expect(result.current.mergedMessages[0].type).toBe('user');
    expect(result.current.mergedMessages[1].type).toBe('user');
    expect(result.current.mergedMessages[1].content).toBe('hello');
  });

  it('renders optimistic /compact as user message during streaming (no XML tags yet)', () => {
    // When user sends /compact during streaming, the optimistic message
    // has no XML tags — it should render as a normal user message.
    // Only backend messages with XML tags should trigger compact grouping.
    const messages: ClaudeMessage[] = [
      makeMessage('user', '/compact', {
        raw: { message: { content: [{ type: 'text', text: '/compact' }] } },
        isOptimistic: true,
        timestamp: '2026-01-01T10:00:00.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useMessageProcessing({ messages, currentSessionId: 'session-1', t }),
    );

    expect(result.current.mergedMessages).toHaveLength(1);
    expect(result.current.mergedMessages[0].type).toBe('user');
    expect(result.current.mergedMessages[0].content).toBe('/compact');
  });

  it('does not group /compact followed by another slash command', () => {
    const messages: ClaudeMessage[] = [
      makeMessage('user', '', {
        raw: { message: { content: '<command-name>/compact</command-name><command-message>compact</command-message>' } },
        timestamp: '2026-01-01T10:00:00.000Z',
      }),
      makeMessage('user', '/help', {
        raw: { message: { content: [{ type: 'text', text: '/help' }] } },
        timestamp: '2026-01-01T10:00:01.000Z',
      }),
    ];

    const { result } = renderHook(() =>
      useMessageProcessing({ messages, currentSessionId: 'session-1', t }),
    );

    // /compact user message + /help user message
    expect(result.current.mergedMessages).toHaveLength(2);
    expect(result.current.mergedMessages[0].type).toBe('user');
    expect(result.current.mergedMessages[1].type).toBe('user');
    expect(result.current.mergedMessages[1].content).toBe('/help');
  });
});
