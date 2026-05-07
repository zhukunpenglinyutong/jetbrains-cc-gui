import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStreamingMessages } from './useStreamingMessages';
import type { ClaudeMessage } from '../types';
import { getContentBlocks, normalizeBlocks } from '../utils/messageUtils';

const localizeMessage = (text: string) => text;
const t = ((key: string) => key) as any;

const getRenderedBlocks = (message: ClaudeMessage) =>
  getContentBlocks(
    message,
    (raw) => normalizeBlocks(raw, localizeMessage, t),
    localizeMessage,
  );

describe('useStreamingMessages', () => {
  it('sets .content from streamingContentRef and syncs a single raw text block', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Hello world';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: false,
      raw: {
        message: {
          content: [{ type: 'text', text: 'Backend text' }],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    expect(patched.content).toBe('Hello world');
    expect(patched.isStreaming).toBe(true);
    // raw text block should stay aligned with what the UI renders during streaming
    const rawContent = (patched.raw as any).message.content;
    expect(rawContent).toHaveLength(1);
    expect(rawContent[0]).toMatchObject({ type: 'text', text: 'Hello world' });
  });

  it('preserves tool_use blocks in raw unchanged', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Running command.';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'Running command.',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'text', text: 'Running command.' },
            { type: 'tool_use', id: 'bash-1', name: 'run_command', input: { command: 'ls' } },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    expect(patched.content).toBe('Running command.');
    const rawContent = (patched.raw as any).message.content;
    expect(rawContent).toHaveLength(2);
    expect(rawContent[1]).toMatchObject({ type: 'tool_use', id: 'bash-1' });
  });

  it('preserves thinking blocks in raw unchanged', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Done.';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'Done.',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think about this.' },
            { type: 'text', text: 'Done.' },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    const rawContent = (patched.raw as any).message.content;
    expect(rawContent).toHaveLength(2);
    expect(rawContent[0]).toMatchObject({ type: 'thinking', thinking: 'Let me think about this.' });
  });

  it('uses backend content when it is longer than delta content (never goes backwards)', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // Delta throttler hasn't flushed yet — streamingContentRef is behind
    result.current.streamingContentRef.current = 'ABC';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'ABCDE',  // backend snapshot is ahead
      isStreaming: true,
      raw: { message: { content: [{ type: 'text', text: 'ABCDE' }] } },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    // Should keep the longer backend content, not jump back to 'ABC'
    expect(patched.content).toBe('ABCDE');
    expect(patched.isStreaming).toBe(true);
  });

  it('uses delta content when it is longer than backend content', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'ABCDEF';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'ABC',
      isStreaming: true,
      raw: { message: { content: [{ type: 'text', text: 'ABC' }] } },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    expect(patched.content).toBe('ABCDEF');
  });

  it('handles missing raw gracefully', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Response';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    expect(patched.content).toBe('Response');
    expect(patched.isStreaming).toBe(true);
    expect(patched.raw).toBeUndefined();
  });

  it('extractRawBlocks correctly extracts blocks from raw', () => {
    const { result } = renderHook(() => useStreamingMessages());

    const blocks = result.current.extractRawBlocks({
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'thinking', thinking: 'Thinking...' },
        ],
      },
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'Hello' });
    expect(blocks[1]).toMatchObject({ type: 'thinking', thinking: 'Thinking...' });
  });

  it('extractRawBlocks returns empty array for null/undefined raw', () => {
    const { result } = renderHook(() => useStreamingMessages());

    expect(result.current.extractRawBlocks(null)).toEqual([]);
    expect(result.current.extractRawBlocks(undefined)).toEqual([]);
    expect(result.current.extractRawBlocks({})).toEqual([]);
  });

  it('keeps rendered text blocks in sync with streaming content when backend raw text is stale', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'ABCDE';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'ABC',
      isStreaming: true,
      raw: {
        message: {
          content: [{ type: 'text', text: 'ABC' }],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const renderedBlocks = getRenderedBlocks(patched);

    expect(renderedBlocks).toHaveLength(1);
    expect(renderedBlocks[0]).toMatchObject({ type: 'text', text: 'ABCDE' });
  });

  it('creates a visible thinking block before the first backend snapshot arrives', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingThinkingRef.current = 'Thinking before snapshot';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const renderedBlocks = getRenderedBlocks(patched);

    expect(renderedBlocks).toHaveLength(1);
    expect(renderedBlocks[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Thinking before snapshot',
      text: 'Thinking before snapshot',
    });
  });

  it('does not duplicate earlier thinking content when a second thinking block follows a tool_use', () => {
    // Extended thinking turn:
    //   thinking_seg1 → tool_use → thinking_seg2
    // streamingThinkingRef accumulates the whole turn ("Let me think...Now I need...").
    // Backend raw blocks already split it into [thinking_1, tool_use, thinking_2].
    // The sync function must only assign the suffix ("Now I need...") to the
    // second block, not the cumulative buffer.
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingThinkingRef.current = 'Let me think...Now I need...';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think...', text: 'Let me think...' },
            { type: 'tool_use', id: 'search-1', name: 'search', input: { q: 'foo' } },
            { type: 'thinking', thinking: 'Now I need...', text: 'Now I need...' },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent).toHaveLength(3);
    expect(rawContent[0]).toMatchObject({ type: 'thinking', thinking: 'Let me think...' });
    expect(rawContent[1]).toMatchObject({ type: 'tool_use', id: 'search-1' });
    // The critical assertion: second thinking block must NOT contain "Let me think..."
    expect(rawContent[2]).toMatchObject({ type: 'thinking', thinking: 'Now I need...' });
  });

  it('extends the last thinking block as new deltas arrive (single segment)', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // Backend snapshot is one frame behind the delta channel
    result.current.streamingThinkingRef.current = 'Thinking longer now';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [{ type: 'thinking', thinking: 'Thinking', text: 'Thinking' }],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent).toHaveLength(1);
    expect(rawContent[0]).toMatchObject({ type: 'thinking', thinking: 'Thinking longer now' });
  });

  it('keeps backend raw structure intact when the cumulative thinking buffer cannot be reconciled', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // streamingThinkingRef does not start with the earlier block's text — could
    // happen if the backend rewrote earlier blocks via dedup.  Sync function
    // should leave structure untouched rather than overwriting incorrectly.
    result.current.streamingThinkingRef.current = 'Completely different content';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Original first', text: 'Original first' },
            { type: 'tool_use', id: 't1', name: 'noop', input: {} },
            { type: 'thinking', thinking: 'Original second', text: 'Original second' },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent[0]).toMatchObject({ thinking: 'Original first' });
    expect(rawContent[2]).toMatchObject({ thinking: 'Original second' });
  });
});

interface ContentBlockTest {
  type: string;
  thinking?: string;
  text?: string;
  id?: string;
}
