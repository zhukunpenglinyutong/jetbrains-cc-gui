import { describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type { ClaudeMessage } from '../../../types';
import {
  OPTIMISTIC_MESSAGE_TIME_WINDOW,
  appendOptimisticMessageIfMissing,
  getRawUuid,
  preserveLastAssistantIdentity,
  preserveMessageIdentity,
  preserveStreamingAssistantContent,
  stripUuidFromRaw,
} from '../messageSync';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ref = <T>(value: T): MutableRefObject<T> => ({ current: value });

const findLastAssistantIndex = (msgs: ClaudeMessage[]): number =>
  msgs.reduce((acc, m, i) => (m.type === 'assistant' ? i : acc), -1);

const patchAssistantForStreaming = (msg: ClaudeMessage): ClaudeMessage => ({
  ...msg,
  isStreaming: true,
});

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

const makeUserMsg = (content: string, extra?: Partial<ClaudeMessage>) =>
  makeMsg('user', content, extra);

const makeAssistantMsg = (content: string, extra?: Partial<ClaudeMessage>) =>
  makeMsg('assistant', content, extra);

// ---------------------------------------------------------------------------
// getRawUuid
// ---------------------------------------------------------------------------

describe('getRawUuid', () => {
  it('returns undefined when msg is undefined', () => {
    expect(getRawUuid(undefined)).toBeUndefined();
  });

  it('returns undefined when msg has no raw field', () => {
    expect(getRawUuid(makeUserMsg('hello'))).toBeUndefined();
  });

  it('returns undefined when raw is a string (not an object)', () => {
    const msg: ClaudeMessage = { ...makeUserMsg('hello'), raw: 'plain-string' as any };
    expect(getRawUuid(msg)).toBeUndefined();
  });

  it('returns undefined when raw.uuid is not a string', () => {
    const msg: ClaudeMessage = { ...makeUserMsg('hello'), raw: { uuid: 42 } as any };
    expect(getRawUuid(msg)).toBeUndefined();
  });

  it('returns uuid string when present', () => {
    const msg: ClaudeMessage = { ...makeUserMsg('hello'), raw: { uuid: 'abc-123' } as any };
    expect(getRawUuid(msg)).toBe('abc-123');
  });
});

// ---------------------------------------------------------------------------
// stripUuidFromRaw
// ---------------------------------------------------------------------------

describe('stripUuidFromRaw', () => {
  it('returns null as-is', () => {
    expect(stripUuidFromRaw(null)).toBeNull();
  });

  it('returns undefined as-is', () => {
    expect(stripUuidFromRaw(undefined)).toBeUndefined();
  });

  it('returns string as-is', () => {
    expect(stripUuidFromRaw('plain')).toBe('plain');
  });

  it('returns object unchanged when uuid is absent', () => {
    const raw = { message: { content: 'hi' } };
    expect(stripUuidFromRaw(raw)).toBe(raw);
  });

  it('removes uuid from object and keeps all other properties', () => {
    const raw = { uuid: 'abc-123', message: 'content', extra: 42 };
    const result = stripUuidFromRaw(raw) as Record<string, unknown>;
    expect(result).not.toHaveProperty('uuid');
    expect(result.message).toBe('content');
    expect(result.extra).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// preserveMessageIdentity
// ---------------------------------------------------------------------------

describe('preserveMessageIdentity', () => {
  it('returns nextMsg unchanged when prevMsg is undefined', () => {
    const next = makeUserMsg('hello');
    expect(preserveMessageIdentity(undefined, next)).toBe(next);
  });

  it('returns nextMsg unchanged when prevMsg has no timestamp', () => {
    const prev = { ...makeUserMsg('prev'), timestamp: undefined };
    const next = makeUserMsg('next');
    expect(preserveMessageIdentity(prev as ClaudeMessage, next)).toBe(next);
  });

  it('returns nextMsg unchanged when types differ', () => {
    const prev = makeUserMsg('prev');
    const next = makeAssistantMsg('next');
    expect(preserveMessageIdentity(prev, next)).toBe(next);
  });

  it('preserves prevMsg timestamp into nextMsg when they differ', () => {
    const prevTimestamp = '2024-01-01T00:00:00.000Z';
    const prev = makeUserMsg('prev', { timestamp: prevTimestamp });
    const next = makeUserMsg('next', { timestamp: '2024-02-01T00:00:00.000Z' });
    const result = preserveMessageIdentity(prev, next);
    expect(result.timestamp).toBe(prevTimestamp);
    expect(result.content).toBe('next');
  });

  it('returns same object reference when timestamps already match', () => {
    const ts = '2024-01-01T00:00:00.000Z';
    const prev = makeUserMsg('prev', { timestamp: ts });
    const next = makeUserMsg('next', { timestamp: ts });
    const result = preserveMessageIdentity(prev, next);
    expect(result.timestamp).toBe(ts);
  });

  it('strips uuid from nextMsg when prev has no uuid but next does', () => {
    const prev = makeUserMsg('prev');
    const next: ClaudeMessage = {
      ...makeUserMsg('next'),
      raw: { uuid: 'should-be-stripped', content: 'data' } as any,
    };
    const result = preserveMessageIdentity(prev, next);
    expect(getRawUuid(result)).toBeUndefined();
    expect((result.raw as any)?.content).toBe('data');
  });

  it('does not strip uuid when prev also has uuid', () => {
    const prevUuid = 'prev-uuid';
    const nextUuid = 'next-uuid';
    const prev: ClaudeMessage = {
      ...makeUserMsg('prev'),
      raw: { uuid: prevUuid } as any,
    };
    const next: ClaudeMessage = {
      ...makeUserMsg('next'),
      raw: { uuid: nextUuid } as any,
    };
    const result = preserveMessageIdentity(prev, next);
    // uuid is not stripped because prevUuid exists
    expect(getRawUuid(result)).toBe(nextUuid);
  });
});

// ---------------------------------------------------------------------------
// appendOptimisticMessageIfMissing
// ---------------------------------------------------------------------------

describe('appendOptimisticMessageIfMissing', () => {
  it('returns nextList unchanged when prev list is empty', () => {
    const next = [makeUserMsg('hi')];
    expect(appendOptimisticMessageIfMissing([], next)).toBe(next);
  });

  it('returns nextList unchanged when last prev is not optimistic', () => {
    const prev = [makeUserMsg('prev')];
    const next = [makeUserMsg('next')];
    expect(appendOptimisticMessageIfMissing(prev, next)).toBe(next);
  });

  it('appends optimistic message when no match in nextList', () => {
    const ts = new Date().toISOString();
    const optimistic = makeUserMsg('hello', { isOptimistic: true, timestamp: ts });
    const prev = [optimistic];
    const next: ClaudeMessage[] = [makeAssistantMsg('different response')];

    const result = appendOptimisticMessageIfMissing(prev, next);
    expect(result).toHaveLength(2);
    expect(result[result.length - 1]).toBe(optimistic);
  });

  it('does not append when optimistic message is matched by content and time', () => {
    const ts = new Date().toISOString();
    const optimistic = makeUserMsg('hello world', { isOptimistic: true, timestamp: ts });
    const backendMsg = makeUserMsg('hello world', { timestamp: ts });
    const prev = [optimistic];
    const next = [backendMsg];

    const result = appendOptimisticMessageIfMissing(prev, next);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(backendMsg);
  });

  it('appends when timestamps exceed the time window', () => {
    const oldTs = new Date(Date.now() - OPTIMISTIC_MESSAGE_TIME_WINDOW - 1000).toISOString();
    const newTs = new Date().toISOString();
    const optimistic = makeUserMsg('hello', { isOptimistic: true, timestamp: oldTs });
    const backendMsg = makeUserMsg('hello', { timestamp: newTs });
    const prev = [optimistic];
    const next = [backendMsg];

    const result = appendOptimisticMessageIfMissing(prev, next);
    expect(result).toHaveLength(2);
  });

  it('merges attachment blocks from optimistic message into matched backend message', () => {
    const ts = new Date().toISOString();
    const attachmentBlock = { type: 'attachment', name: 'file.txt', data: 'base64data' };
    const optimistic = makeUserMsg('hello', {
      isOptimistic: true,
      timestamp: ts,
      raw: {
        message: {
          content: [attachmentBlock, { type: 'text', text: 'hello' }],
        },
      } as any,
    });
    const backendMsg = makeUserMsg('hello', { timestamp: ts });
    const prev = [optimistic];
    const next = [backendMsg];

    const result = appendOptimisticMessageIfMissing(prev, next);
    expect(result).toHaveLength(1);
    const raw = result[0].raw as any;
    expect(Array.isArray(raw?.message?.content)).toBe(true);
    const hasAttachment = raw.message.content.some((b: any) => b.type === 'attachment');
    expect(hasAttachment).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// preserveLastAssistantIdentity
// ---------------------------------------------------------------------------

describe('preserveLastAssistantIdentity', () => {
  it('returns nextList unchanged when prevList has no assistant', () => {
    const prev = [makeUserMsg('hello')];
    const next = [makeAssistantMsg('response')];
    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    expect(result).toBe(next);
  });

  it('returns nextList unchanged when nextList has no assistant', () => {
    const prev = [makeAssistantMsg('prev response')];
    const next = [makeUserMsg('follow-up')];
    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    expect(result).toBe(next);
  });

  it('stabilizes the identity of the last assistant message', () => {
    const prevTs = '2024-01-01T10:00:00.000Z';
    const prev = [makeAssistantMsg('first', { timestamp: prevTs })];
    const next = [makeAssistantMsg('updated', { timestamp: '2024-01-01T10:00:01.000Z' })];

    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    expect(result[0].timestamp).toBe(prevTs);
    expect(result[0].content).toBe('updated');
  });

  it('returns the same nextList reference when no identity change is needed', () => {
    const ts = '2024-01-01T10:00:00.000Z';
    const prev = [makeAssistantMsg('response', { timestamp: ts })];
    const next = [makeAssistantMsg('response', { timestamp: ts })];

    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    // Since timestamps match, preserveMessageIdentity returns next unchanged
    expect(result[0].timestamp).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// preserveStreamingAssistantContent
// ---------------------------------------------------------------------------

describe('preserveStreamingAssistantContent', () => {
  it('returns nextList unchanged when not streaming', () => {
    const prev = [makeAssistantMsg('streamed long content here')];
    const next = [makeAssistantMsg('short')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(false), ref('streamed long content here'),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result).toBe(next);
  });

  it('returns nextList unchanged when prevList has no assistant', () => {
    const prev = [makeUserMsg('hello')];
    const next = [makeAssistantMsg('response')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(''),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result).toBe(next);
  });

  it('returns nextList unchanged when nextList has no assistant', () => {
    const prev = [makeAssistantMsg('streamed content')];
    const next = [makeUserMsg('user reply')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(''),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result).toBe(next);
  });

  it('returns nextList unchanged when preferred content is not longer than next content', () => {
    const prev = [makeAssistantMsg('short')];
    const next = [makeAssistantMsg('longer backend content')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref('short'),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result).toBe(next);
  });

  it('replaces next assistant content with streamed content when longer', () => {
    const longStreamed = 'a'.repeat(100);
    const prev = [makeAssistantMsg(longStreamed)];
    const next = [makeAssistantMsg('short stale')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(longStreamed),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result).not.toBe(next);
    expect(result[0].content).toBe(longStreamed);
    expect(result[0].isStreaming).toBe(true);
  });

  it('prefers buffer content over prev content when buffer is longer', () => {
    const prevContent = 'prev content';
    const bufferedContent = prevContent + ' with more streamed text';
    const prev = [makeAssistantMsg(prevContent)];
    const next = [makeAssistantMsg('stale short')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(bufferedContent),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result[0].content).toBe(bufferedContent);
  });

  it('uses prev content when buffer is empty or shorter', () => {
    const prevContent = 'longer prev content from a previous render';
    const prev = [makeAssistantMsg(prevContent)];
    const next = [makeAssistantMsg('short stale')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(''),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result[0].content).toBe(prevContent);
  });

  it('handles multi-message list and only patches the last assistant', () => {
    const longContent = 'long streaming content that should be preserved';
    const prev = [makeUserMsg('q'), makeAssistantMsg(longContent)];
    const next = [makeUserMsg('q'), makeAssistantMsg('stale snapshot')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(longContent),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result[0]).toBe(next[0]); // user message unchanged
    expect(result[1].content).toBe(longContent);
  });

  it('does not merge content across different turn IDs', () => {
    const longContent = 'long content from turn 1';
    const prev = [makeAssistantMsg(longContent, { __turnId: 1 })];
    const next = [makeAssistantMsg('short', { __turnId: 2 })];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(longContent),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result).toBe(next);
  });

  it('allows merge when both have same turn ID', () => {
    const longContent = 'long streamed content';
    const prev = [makeAssistantMsg(longContent, { __turnId: 1 })];
    const next = [makeAssistantMsg('short', { __turnId: 1 })];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(longContent),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result[0].content).toBe(longContent);
  });

  it('allows merge when neither has turn ID (backward compat)', () => {
    const longContent = 'long content without turn ID';
    const prev = [makeAssistantMsg(longContent)];
    const next = [makeAssistantMsg('short')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(longContent),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result[0].content).toBe(longContent);
  });
});

// ---------------------------------------------------------------------------
// preserveLastAssistantIdentity — turn ID guards
// ---------------------------------------------------------------------------

describe('preserveLastAssistantIdentity — turn ID guards', () => {
  it('does not merge identity across different turn IDs', () => {
    const prevTs = '2024-01-01T10:00:00.000Z';
    const prev = [makeAssistantMsg('a1', { timestamp: prevTs, __turnId: 1 })];
    const next = [makeAssistantMsg('a2', { timestamp: '2024-01-01T10:00:01.000Z', __turnId: 2 })];

    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    expect(result).toBe(next);
    expect(result[0].timestamp).not.toBe(prevTs);
  });

  it('merges identity when both have same turn ID', () => {
    const prevTs = '2024-01-01T10:00:00.000Z';
    const prev = [makeAssistantMsg('a1', { timestamp: prevTs, __turnId: 1 })];
    const next = [makeAssistantMsg('a1 updated', { timestamp: '2024-01-01T10:00:01.000Z', __turnId: 1 })];

    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    expect(result[0].timestamp).toBe(prevTs);
  });

  it('merges identity when neither has turn ID (backward compat)', () => {
    const prevTs = '2024-01-01T10:00:00.000Z';
    const prev = [makeAssistantMsg('a1', { timestamp: prevTs })];
    const next = [makeAssistantMsg('a1 updated', { timestamp: '2024-01-01T10:00:01.000Z' })];

    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    expect(result[0].timestamp).toBe(prevTs);
  });

  it('allows merge when only one has turn ID (Java message without turnId)', () => {
    const prevTs = '2024-01-01T10:00:00.000Z';
    const prev = [makeAssistantMsg('a1', { timestamp: prevTs, __turnId: 1 })];
    const next = [makeAssistantMsg('a1', { timestamp: '2024-01-01T10:00:01.000Z' })];

    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    expect(result[0].timestamp).toBe(prevTs);
  });
});
