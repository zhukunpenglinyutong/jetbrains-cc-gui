import { describe, expect, it } from 'vitest';
import type { MutableRefObject } from 'react';
import type { ClaudeMessage } from '../../../types';
import {
  OPTIMISTIC_MESSAGE_TIME_WINDOW,
  appendOptimisticMessageIfMissing,
  ensureStreamingAssistantInList,
  getRawUuid,
  mergeRawBlocksDuringStreaming,
  preserveLastAssistantIdentity,
  preserveMessageIdentity,
  preserveStreamingAssistantContent,
  stripDuplicateTrailingToolMessages,
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

  it('matches the latest backend user message by content even when confirmation is delayed', () => {
    const oldTs = new Date(Date.now() - OPTIMISTIC_MESSAGE_TIME_WINDOW - 1000).toISOString();
    const newTs = new Date().toISOString();
    const optimistic = makeUserMsg('slow confirmation', { isOptimistic: true, timestamp: oldTs });
    const backendMsg = makeUserMsg('slow confirmation', { timestamp: newTs });
    const prev = [optimistic];
    const next = [backendMsg];

    const result = appendOptimisticMessageIfMissing(prev, next);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(backendMsg);
  });

  it('matches delayed optimistic text against the latest backend user when older history has same content', () => {
    const optimistic = makeUserMsg('repeatable prompt', {
      isOptimistic: true,
      timestamp: new Date(Date.now() - OPTIMISTIC_MESSAGE_TIME_WINDOW - 1000).toISOString(),
    });
    const olderBackend = makeUserMsg('repeatable prompt', { timestamp: '2026-04-26T00:00:00.000Z' });
    const latestBackend = makeUserMsg('repeatable prompt', { timestamp: new Date().toISOString() });

    const result = appendOptimisticMessageIfMissing(
      [olderBackend, optimistic],
      [olderBackend, makeAssistantMsg('old answer'), latestBackend],
    );

    expect(result).toHaveLength(3);
    expect(result[2]).toBe(latestBackend);
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

  it('blocks merge when only prev has turn ID (streaming vs history)', () => {
    const longContent = 'long streaming content';
    const prev = [makeAssistantMsg(longContent, { __turnId: 1 })];
    const next = [makeAssistantMsg('history snapshot')];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref(longContent),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result).toBe(next);
    expect(result[0].content).toBe('history snapshot');
  });

  it('blocks merge when only next has turn ID (history vs streaming)', () => {
    const prev = [makeAssistantMsg('old history content')];
    const next = [makeAssistantMsg('new streaming', { __turnId: 2 })];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref('buffer'),
      findLastAssistantIndex, patchAssistantForStreaming,
    );
    expect(result).toBe(next);
    expect(result[0].content).toBe('new streaming');
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

  it('blocks merge when only prev has turn ID (streaming vs history)', () => {
    const prevTs = '2024-01-01T10:00:00.000Z';
    const prev = [makeAssistantMsg('streaming', { timestamp: prevTs, __turnId: 1 })];
    const next = [makeAssistantMsg('history snapshot', { timestamp: '2024-01-01T10:00:01.000Z' })];

    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    expect(result).toBe(next);
    expect(result[0].timestamp).not.toBe(prevTs);
  });

  it('blocks merge when only next has turn ID (history vs streaming)', () => {
    const prevTs = '2024-01-01T10:00:00.000Z';
    const prev = [makeAssistantMsg('history', { timestamp: prevTs })];
    const next = [makeAssistantMsg('streaming', { timestamp: '2024-01-01T10:00:01.000Z', __turnId: 2 })];

    const result = preserveLastAssistantIdentity(prev, next, findLastAssistantIndex);
    expect(result).toBe(next);
    expect(result[0].timestamp).not.toBe(prevTs);
  });
});

// ---------------------------------------------------------------------------
// stripDuplicateTrailingToolMessages
// ---------------------------------------------------------------------------

describe('stripDuplicateTrailingToolMessages', () => {
  it('removes duplicated trailing tool-only messages in Codex snapshots', () => {
    const list = [
      makeAssistantMsg('', {
        raw: { message: { content: [{ type: 'tool_use', id: 'cmd-1', name: 'shell_command', input: { command: 'Get-ChildItem' } }] } } as any,
      }),
      makeUserMsg('', {
        raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'cmd-1', content: 'ok' }] } } as any,
      }),
      makeAssistantMsg('done'),
      makeAssistantMsg('', {
        raw: { message: { content: [{ type: 'tool_use', id: 'cmd-1', name: 'shell_command', input: { command: 'Get-ChildItem' } }] } } as any,
      }),
      makeUserMsg('', {
        raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'cmd-1', content: 'ok' }] } } as any,
      }),
    ];

    const result = stripDuplicateTrailingToolMessages(list, 'codex');
    expect(result).toHaveLength(3);
    expect(result[2].content).toBe('done');
  });

  it('keeps the first visible tool-only messages when there is no duplicate tail', () => {
    const list = [
      makeAssistantMsg('', {
        raw: { message: { content: [{ type: 'tool_use', id: 'spawn-1', name: 'spawn_agent', input: { agent_type: 'worker' } }] } } as any,
      }),
      makeUserMsg('', {
        raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: 'subagent ok' }] } } as any,
      }),
    ];

    const result = stripDuplicateTrailingToolMessages(list, 'codex');
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ensureStreamingAssistantInList — race condition & fallback
// ---------------------------------------------------------------------------

describe('ensureStreamingAssistantInList', () => {
  // ---- Primary path (refs valid) ----

  it('returns resultList unchanged when streaming assistant already in resultList', () => {
    const prev = [makeAssistantMsg('streaming', { __turnId: 1, isStreaming: true })];
    const result = [makeAssistantMsg('streaming', { __turnId: 1, isStreaming: true })];

    const { list, streamingIndex } = ensureStreamingAssistantInList(prev, result, true, 1);
    expect(list).toBe(result);
    expect(streamingIndex).toBe(0);
  });

  it('appends streaming assistant from prev when missing from result (primary path)', () => {
    const streamingMsg = makeAssistantMsg('streaming content', { __turnId: 1, isStreaming: true });
    const prev = [makeUserMsg('q'), streamingMsg];
    const result = [makeUserMsg('q')];

    const { list, streamingIndex } = ensureStreamingAssistantInList(prev, result, true, 1);
    expect(list).toHaveLength(2);
    expect(list[1]).toBe(streamingMsg);
    expect(streamingIndex).toBe(1);
  });

  // ---- Fallback path (refs cleared — race condition) ----

  it('recovers streaming assistant from prevList when refs are already cleared', () => {
    const streamingMsg = makeAssistantMsg('last streamed', { __turnId: 5, isStreaming: true });
    const prev = [makeUserMsg('q'), streamingMsg];
    const result = [makeUserMsg('q')];

    // Simulate race: isStreaming=false, turnId=0 (cleared by onStreamEnd)
    const { list, streamingIndex } = ensureStreamingAssistantInList(prev, result, false, 0);
    expect(list).toHaveLength(2);
    expect(list[1]).toBe(streamingMsg);
    expect(streamingIndex).toBe(1);
  });

  it('does NOT recover non-streaming assistant from prevList when refs are cleared', () => {
    const finishedMsg = makeAssistantMsg('done', { __turnId: 5, isStreaming: false });
    const prev = [makeUserMsg('q'), finishedMsg];
    const result = [makeUserMsg('q')];

    const { list, streamingIndex } = ensureStreamingAssistantInList(prev, result, false, 0);
    expect(list).toBe(result);
    expect(streamingIndex).toBe(-1);
  });

  it('does NOT recover assistant without __turnId from prevList when refs are cleared', () => {
    const noTurnMsg = makeAssistantMsg('old msg', { isStreaming: true });
    const prev = [makeUserMsg('q'), noTurnMsg];
    const result = [makeUserMsg('q')];

    const { list, streamingIndex } = ensureStreamingAssistantInList(prev, result, false, 0);
    expect(list).toBe(result);
    expect(streamingIndex).toBe(-1);
  });

  it('does not duplicate when resultList already contains the streaming assistant (fallback)', () => {
    const streamingMsg = makeAssistantMsg('streaming', { __turnId: 3, isStreaming: true });
    const prev = [streamingMsg];
    const result = [makeAssistantMsg('streaming', { __turnId: 3 })];

    const { list, streamingIndex } = ensureStreamingAssistantInList(prev, result, false, 0);
    expect(list).toBe(result);
    expect(streamingIndex).toBe(-1);
  });

  it('returns resultList unchanged when prevList has no streaming assistant and refs cleared', () => {
    const prev = [makeUserMsg('q'), makeAssistantMsg('done', { isStreaming: false })];
    const result = [makeUserMsg('q')];

    const { list, streamingIndex } = ensureStreamingAssistantInList(prev, result, false, 0);
    expect(list).toBe(result);
    expect(streamingIndex).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// preserveStreamingAssistantContent — raw blocks protection
//
// Root cause being tested:
//   After Phase-1 fix, [MESSAGE] is no longer sent for pure-text streaming turns.
//   [USAGE] and other minor backend pushes still trigger updateMessages which
//   carries a *stale* raw snapshot (shorter text blocks than what segments have
//   already accumulated).  preserveStreamingAssistantContent guards .content
//   (the string), but NOT .raw.message.content blocks.  MarkdownBlock renders
//   from blocks, so a stale backend raw overwrites the streamed raw, producing
//   the "ABCDE → ABC → ABCDEF" flicker visible to users.
// ---------------------------------------------------------------------------

describe('preserveStreamingAssistantContent — raw blocks protection', () => {
  // Helper: extract text from raw blocks
  const getRawTextAt = (msg: ClaudeMessage, blockIdx = 0): string | undefined =>
    ((msg.raw as any)?.message?.content?.[blockIdx] as any)?.text;

  it('protects raw text blocks from backend regression when content string is also protected', () => {
    // Simulates: segments accumulated "ABCDE", backend snapshot has raw.text="ABC"
    // preserveStreamingAssistantContent kicks in for content (prev>next length)
    // but must ALSO protect the raw text block, not just the .content string.
    const prev = [makeAssistantMsg('ABCDE', {
      isStreaming: true,
      raw: { message: { content: [{ type: 'text', text: 'ABCDE' }] } } as any,
    })];
    const next = [makeAssistantMsg('ABC', {
      raw: { message: { content: [{ type: 'text', text: 'ABC' }] } } as any,
    })];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref('ABCDE'),
      findLastAssistantIndex, patchAssistantForStreaming,
    );

    // .content string already guarded by existing logic
    expect(result[0].content).toBe('ABCDE');
    // raw blocks must also reflect the longer streamed value — not the stale backend value
    expect(getRawTextAt(result[0], 0)).toBe('ABCDE');
  });

  it('protects raw text blocks even when backend content length equals streamed length', () => {
    // Edge case: backend content string matches streamingContentRef length
    // so current impl returns nextList unchanged (no content protection).
    // But raw.text may still be stale (same length ≠ same content).
    // Scenario: streamingContentRef="ABCDE", backend.content="ABCDE", backend.raw.text="ABC"
    const prev = [makeAssistantMsg('ABCDE', {
      isStreaming: true,
      raw: { message: { content: [{ type: 'text', text: 'ABCDE' }] } } as any,
    })];
    const next = [makeAssistantMsg('ABCDE', {
      raw: { message: { content: [{ type: 'text', text: 'ABC' }] } } as any,
    })];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref('ABCDE'),
      findLastAssistantIndex, patchAssistantForStreaming,
    );

    // raw text block must not regress to shorter stale value
    expect(getRawTextAt(result[0], 0)).toBe('ABCDE');
  });

  it('injects new tool_use from backend while keeping streamed text block intact', () => {
    // Simulates: text streaming "ABCDE" ongoing; backend pushes snapshot with
    // stale text "AB" + a newly-appeared tool_use block.
    // Expected: text block stays "ABCDE", tool_use block is preserved.
    const prev = [makeAssistantMsg('ABCDE', {
      isStreaming: true,
      raw: {
        message: {
          content: [{ type: 'text', text: 'ABCDE' }],
        },
      } as any,
    })];
    const next = [makeAssistantMsg('AB', {
      raw: {
        message: {
          content: [
            { type: 'text', text: 'AB' },
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/foo' } },
          ],
        },
      } as any,
    })];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref('ABCDE'),
      findLastAssistantIndex, patchAssistantForStreaming,
    );

    const blocks = (result[0].raw as any)?.message?.content as any[];
    expect(blocks).toHaveLength(2);
    // text block: streamed value wins
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toBe('ABCDE');
    // tool_use block: kept from backend (it was not in prev)
    expect(blocks[1].type).toBe('tool_use');
    expect(blocks[1].id).toBe('tu-1');
  });

  it('does not regress thinking block raw content when backend has shorter thinking', () => {
    // Same scenario as text, but for thinking blocks
    const longThinking = 'A'.repeat(200);
    const shortThinking = 'A'.repeat(50);
    const prev = [makeAssistantMsg('answer', {
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: longThinking },
            { type: 'text', text: 'answer' },
          ],
        },
      } as any,
    })];
    const next = [makeAssistantMsg('ans', {
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: shortThinking },
            { type: 'text', text: 'ans' },
          ],
        },
      } as any,
    })];

    const result = preserveStreamingAssistantContent(
      prev, next, ref(true), ref('answer'),
      findLastAssistantIndex, patchAssistantForStreaming,
    );

    const blocks = (result[0].raw as any)?.message?.content as any[];
    expect(blocks[0].type).toBe('thinking');
    expect((blocks[0].thinking as string).length).toBe(longThinking.length);
    expect(blocks[1].text).toBe('answer');
  });
});

// ---------------------------------------------------------------------------
// mergeRawBlocksDuringStreaming
//
// Tests the length-based comparison and content validation logic for
// protecting streamed text/thinking blocks from stale backend snapshots.
// ---------------------------------------------------------------------------

describe('mergeRawBlocksDuringStreaming', () => {
  // Helper to extract text from a raw block result
  const textBlock = (text: string) => ({ type: 'text', text });
  const thinkingBlock = (thinking: string) => ({ type: 'thinking', thinking, text: thinking });
  const toolUseBlock = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} });

  // -- Guard: returns nextRaw unchanged when inputs are invalid --

  describe('guard clauses', () => {
    it('returns nextRaw unchanged when prevRaw is null', () => {
      const next = { message: { content: [textBlock('hello')] } };
      expect(mergeRawBlocksDuringStreaming(null, next)).toBe(next);
    });

    it('returns nextRaw unchanged when prevRaw is undefined', () => {
      const next = { message: { content: [textBlock('hello')] } };
      expect(mergeRawBlocksDuringStreaming(undefined, next)).toBe(next);
    });

    it('returns nextRaw unchanged when prevRaw is a string', () => {
      const next = { message: { content: [textBlock('hello')] } };
      expect(mergeRawBlocksDuringStreaming('raw-string', next)).toBe(next);
    });

    it('returns nextRaw unchanged when nextRaw is null', () => {
      const prev = { message: { content: [textBlock('long')] } };
      expect(mergeRawBlocksDuringStreaming(prev, null)).toBe(null);
    });

    it('returns nextRaw unchanged when nextRaw is undefined', () => {
      const prev = { message: { content: [textBlock('long')] } };
      expect(mergeRawBlocksDuringStreaming(prev, undefined)).toBe(undefined);
    });

    it('returns nextRaw unchanged when nextRaw has empty blocks', () => {
      const prev = { message: { content: [textBlock('long')] } };
      const next = { message: { content: [] } };
      expect(mergeRawBlocksDuringStreaming(prev, next)).toBe(next);
    });

    it('returns nextRaw unchanged when nextRaw has no content array', () => {
      const prev = { message: { content: [textBlock('long')] } };
      const next = { message: {} };
      expect(mergeRawBlocksDuringStreaming(prev, next)).toBe(next);
    });
  });

  // -- prevLen < nextLen: return nextBlock (backend is more up-to-date) --

  describe('prevLen < nextLen: nextBlock wins', () => {
    it('returns nextBlock when prev text block is shorter', () => {
      const prev = { message: { content: [textBlock('AB')] } };
      const next = { message: { content: [textBlock('ABCDE')] } };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks[0].text).toBe('ABCDE');
    });

    it('returns nextBlock when prev thinking block is shorter', () => {
      const prev = { message: { content: [thinkingBlock('short')] } };
      const next = { message: { content: [thinkingBlock('much longer thinking')] } };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks[0].thinking).toBe('much longer thinking');
    });

    it('returns same nextRaw reference when no protection needed (all next longer)', () => {
      const prev = { message: { content: [textBlock('A')] } };
      const next = { message: { content: [textBlock('ABCDE')] } };

      // When no block needs protecting, nextRaw should be returned unchanged
      const result = mergeRawBlocksDuringStreaming(prev, next);
      expect(result).toBe(next);
    });

    it('returns nextBlock when prev has no text-like blocks to compare', () => {
      // prev has only a tool_use block (not text-like), so prevBlock is undefined
      const prev = { message: { content: [toolUseBlock('tu-1', 'Read')] } };
      const next = { message: { content: [textBlock('ABCDE')] } };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks[0].text).toBe('ABCDE');
    });
  });

  // -- prevLen === nextLen: content validation --

  describe('prevLen === nextLen: content validation', () => {
    it('returns nextBlock when lengths are equal and next content is same length', () => {
      const prev = { message: { content: [textBlock('ABCDE')] } };
      const next = { message: { content: [textBlock('FGHIJ')] } };

      // Both length 5; nextContent.length (5) >= prevContent.length (5) => return nextBlock
      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks[0].text).toBe('FGHIJ');
    });

    it('returns nextBlock when lengths are equal and content is identical', () => {
      const prev = { message: { content: [textBlock('ABCDE')] } };
      const next = { message: { content: [textBlock('ABCDE')] } };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      // Should be same reference since no change is needed
      expect(result).toBe(next);
    });

    it('uses prev content when lengths are equal but next content is shorter', () => {
      // This is a subtle edge case: getTextLikeLength counts character length,
      // but getTextLikeContent might return a different length if the block
      // has non-standard fields. In normal text blocks, getTextLikeLength
      // returns block.text.length and getTextLikeContent returns block.text,
      // so they are the same. This test verifies the actual code path.
      const prev = { message: { content: [textBlock('ABCDE')] } };
      // Create a text block where text.length equals prev text length
      // but getTextLikeContent returns something shorter (edge case with thinking blocks)
      const next = { message: { content: [{ type: 'text', text: 'ABCDE' }] } };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      // prevLen === nextLen (5 === 5), nextContent.length (5) >= prevContent.length (5) => nextBlock wins
      expect(result).toBe(next);
    });

    it('thinking block with equal lengths: nextBlock wins when content length matches', () => {
      const prev = { message: { content: [thinkingBlock('ABCDE')] } };
      const next = { message: { content: [thinkingBlock('FGHIJ')] } };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks[0].thinking).toBe('FGHIJ');
    });
  });

  // -- prevLen > nextLen: use prev content (protection case) --

  describe('prevLen > nextLen: prev content wins (protection)', () => {
    it('replaces shorter next text block with longer prev text', () => {
      const prev = { message: { content: [textBlock('ABCDE')] } };
      const next = { message: { content: [textBlock('AB')] } };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks[0].text).toBe('ABCDE');
      // Should NOT be the same reference since content was modified
      expect(result).not.toBe(next);
    });

    it('replaces shorter next thinking block with longer prev thinking', () => {
      const prev = { message: { content: [thinkingBlock('Long reasoning here')] } };
      const next = { message: { content: [thinkingBlock('Short')] } };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks[0].thinking).toBe('Long reasoning here');
      expect(blocks[0].text).toBe('Long reasoning here');
    });

    it('protects text block while keeping structural blocks from next', () => {
      const prev = {
        message: { content: [textBlock('ABCDE')] },
      };
      const next = {
        message: {
          content: [
            textBlock('AB'),
            toolUseBlock('tu-1', 'Read'),
          ],
        },
      };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks).toHaveLength(2);
      expect(blocks[0].text).toBe('ABCDE'); // protected from prev
      expect(blocks[1].type).toBe('tool_use'); // kept from next
      expect(blocks[1].id).toBe('tu-1');
    });

    it('protects multiple text-like blocks positionally', () => {
      const prev = {
        message: {
          content: [
            thinkingBlock('Deep thought ABCDE'),
            textBlock('Response FGHIJ'),
          ],
        },
      };
      const next = {
        message: {
          content: [
            thinkingBlock('Shallow'),
            textBlock('Short'),
          ],
        },
      };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks).toHaveLength(2);
      expect(blocks[0].thinking).toBe('Deep thought ABCDE');
      expect(blocks[1].text).toBe('Response FGHIJ');
    });
  });

  // -- Mixed scenarios --

  describe('mixed scenarios', () => {
    it('handles interleaved structural and text blocks correctly', () => {
      // prev: [text("ABCDE"), tool_use, text("FGHIJ")]
      // next: [text("AB"),     tool_use, text("FG")]
      // Expected: [text("ABCDE"), tool_use, text("FGHIJ")]
      const prev = {
        message: {
          content: [
            textBlock('ABCDE'),
            toolUseBlock('tu-1', 'Read'),
            textBlock('FGHIJ'),
          ],
        },
      };
      const next = {
        message: {
          content: [
            textBlock('AB'),
            toolUseBlock('tu-1', 'Read'),
            textBlock('FG'),
          ],
        },
      };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks).toHaveLength(3);
      expect(blocks[0].text).toBe('ABCDE');
      expect(blocks[1].type).toBe('tool_use');
      expect(blocks[2].text).toBe('FGHIJ');
    });

    it('returns same reference when next blocks are all longer or equal', () => {
      const prev = {
        message: {
          content: [textBlock('A'), thinkingBlock('B')],
        },
      };
      const next = {
        message: {
          content: [textBlock('AAAA'), thinkingBlock('BBBB')],
        },
      };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      expect(result).toBe(next);
    });

    it('handles raw with top-level content (no message wrapper)', () => {
      const prev = { content: [textBlock('ABCDE')] };
      const next = { content: [textBlock('AB')] };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).content;
      expect(blocks[0].text).toBe('ABCDE');
    });

    it('preserves non-text-like blocks unchanged from next', () => {
      const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } };
      const next = {
        message: {
          content: [
            textBlock('short'),
            imageBlock,
            toolUseBlock('tu-1', 'Write'),
          ],
        },
      };
      const prev = {
        message: {
          content: [textBlock('much longer text')],
        },
      };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks).toHaveLength(3);
      expect(blocks[0].text).toBe('much longer text');
      expect(blocks[1].type).toBe('image');
      expect(blocks[2].type).toBe('tool_use');
    });

    it('handles empty prev blocks array', () => {
      const next = { message: { content: [textBlock('hello')] } };
      const prev = { message: { content: [] } };

      // prev has no text-like blocks, so prevBlock is undefined => nextBlock returned
      const result = mergeRawBlocksDuringStreaming(prev, next);
      expect(result).toBe(next);
    });

    it('handles thinking block without thinking field (falls back to text field)', () => {
      // Some API responses may use .text instead of .thinking on thinking blocks
      const prev = {
        message: {
          content: [{ type: 'thinking', text: 'long thinking text here' }],
        },
      };
      const next = {
        message: {
          content: [{ type: 'thinking', text: 'short' }],
        },
      };

      const result = mergeRawBlocksDuringStreaming(prev, next);
      const blocks = (result as any).message.content;
      expect(blocks[0].text).toBe('long thinking text here');
      expect(blocks[0].thinking).toBe('long thinking text here');
    });

    it('handles non-string text field gracefully', () => {
      const prev = {
        message: {
          content: [{ type: 'text', text: 123 }],
        },
      };
      const next = {
        message: {
          content: [{ type: 'text', text: 'hello' }],
        },
      };

      // prev text is not a string => getTextLikeLength returns 0
      // prevLen (0) < nextLen (5) => nextBlock wins
      const result = mergeRawBlocksDuringStreaming(prev, next);
      expect(result).toBe(next);
    });
  });
});
