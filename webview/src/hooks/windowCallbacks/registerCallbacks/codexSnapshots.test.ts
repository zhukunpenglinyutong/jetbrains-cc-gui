import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeMessage } from '../../../types';
import { mergeConsecutiveAssistantMessages } from '../../../utils/messageUtils';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { registerMessageCallbacks } from './messageCallbacks';
import { registerStreamingCallbacks } from './streamingCallbacks';

const ref = <T,>(current: T) => ({ current });
const user: ClaudeMessage = { type: 'user', content: 'question', timestamp: '2026-10-03T00:00:00Z' };
const snapshot = (content: string, id = 'final'): ClaudeMessage => ({
  type: 'assistant', content, timestamp: '2026-10-03T00:00:01Z',
  raw: { uuid: id, codexThreadId: 'thread', codexTurnId: 'turn', codexItemId: id, codexSnapshot: true,
    message: { content: [{ type: 'text', text: content }] } },
});

function harness(setMessages?: UseWindowCallbacksOptions['setMessages']) {
  let messages = [user];
  const options = {
    currentProviderRef: ref('codex'), currentSessionIdRef: ref('thread'),
    streamingContentRef: ref(''), streamingThinkingRef: ref(''), isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false), streamingMessageIndexRef: ref(-1), streamingTurnIdRef: ref(-1),
    turnIdCounterRef: ref(0), autoExpandedThinkingKeysRef: ref(new Set()),
    lastContentUpdateRef: ref(0), lastThinkingUpdateRef: ref(0),
    contentUpdateTimeoutRef: ref(null), thinkingUpdateTimeoutRef: ref(null),
    setMessages: setMessages ?? ((next: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next;
    }),
    findLastAssistantIndex: (list: ClaudeMessage[]) => list.reduce((last, message, index) => message.type === 'assistant' ? index : last, -1),
    extractRawBlocks: (raw: ClaudeMessage['raw']) => typeof raw === 'object' ? raw?.message?.content ?? [] : [],
    patchAssistantForStreaming: (message: ClaudeMessage) => message,
    setStreamingActive: vi.fn(), setLoading: vi.fn(), setLoadingStartTime: vi.fn(), setIsThinking: vi.fn(),
    setExpandedThinking: vi.fn(), addToast: vi.fn(), setStatus: vi.fn(), setHistoryData: vi.fn(),
    getOrCreateStreamingAssistantIndex: () => -1,
  } as unknown as UseWindowCallbacksOptions;
  registerMessageCallbacks(options, vi.fn(), vi.fn());
  registerStreamingCallbacks(options);
  act(() => window.onStreamStart!());
  return { options, getMessages: () => messages };
}

describe('Codex native snapshots at stream end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.__sessionTransitioning = false;
    window.__minAcceptedUpdateSequence = 0;
    window.__prependedHistoryMessageCount = 0;
    window.__messageBaseIndex = 0;
  });
  afterEach(() => {
    window.__cancelPendingUpdateMessages?.();
    delete window.__flushPendingUpdateMessages;
    if (window.__stallWatchdogInterval != null) clearInterval(window.__stallWatchdogInterval);
    vi.useRealTimers();
  });
  it('keeps the turn duration on the rendered message when a turn has several native items', () => {
    const state = harness();
    window.updateMessages!(JSON.stringify([user, snapshot('先检查代码', 'commentary'), snapshot('完成', 'final')]));
    vi.advanceTimersByTime(3000);
    window.onStreamEnd!();
    const rendered = mergeConsecutiveAssistantMessages(state.getMessages(),
      raw => (typeof raw === 'object' ? raw?.message?.content ?? [] : []) as never);
    expect(rendered.filter(message => message.type === 'assistant')).toHaveLength(1);
    expect(rendered.at(-1)?.durationMs).toBeGreaterThanOrEqual(3000);
  });
  it('accepts text-only snapshots after the first character and retains the complete final text', () => {
    const state = harness();
    window.updateMessages!(JSON.stringify([user, snapshot('修')]));
    vi.advanceTimersByTime(16);
    state.options.streamingContentRef.current = '修';
    window.updateMessages!(JSON.stringify([user, snapshot('修复已完成，所有检查通过。')]));
    vi.advanceTimersByTime(16);
    expect(state.getMessages().at(-1)?.content).toBe('修复已完成，所有检查通过。');
    window.onStreamEnd!();
    expect(state.getMessages().at(-1)?.content).toBe('修复已完成，所有检查通过。');
  });
  it('flushes all pending native items before cancelling the end timer', () => {
    const state = harness();
    window.updateMessages!(JSON.stringify([user, snapshot('中间说明', 'commentary'), snapshot('完成', 'final')]));
    window.onStreamEnd!();
    expect(state.getMessages().filter(message => message.type === 'assistant').map(message => message.content))
      .toEqual(['中间说明', '完成']);
    vi.advanceTimersByTime(50);
    expect(state.getMessages().at(-1)?.isStreaming).toBe(false);
  });
  it('does not copy a longer commentary into a different final item in the same turn', () => {
    const state = harness();
    const commentary = snapshot('这里是同回合较长的中间说明', 'commentary');
    window.updateMessages!(JSON.stringify([user, commentary]));
    vi.advanceTimersByTime(16);
    state.options.streamingContentRef.current = commentary.content ?? '';
    window.updateMessageTail!(JSON.stringify([commentary, snapshot('完成')]), 1);
    window.onStreamEnd!();
    expect(state.getMessages().at(-1)?.content).toBe('完成');
    expect(state.getMessages().at(-1)?.raw).toMatchObject({ codexItemId: 'final' });
  });
  it('keeps a shorter authoritative correction for the same item', () => {
    const state = harness();
    window.updateMessages!(JSON.stringify([user, snapshot('原始较长预览内容')]));
    vi.advanceTimersByTime(16);
    state.options.streamingContentRef.current = '原始较长预览内容';
    window.updateMessages!(JSON.stringify([user, snapshot('纠正')]));
    window.onStreamEnd!();
    expect(state.getMessages().at(-1)?.content).toBe('纠正');
    expect(state.getMessages().at(-1)?.raw).toMatchObject({ message: { content: [{ type: 'text', text: '纠正' }] } });
  });
  it('applies a buffered full snapshot before the next batch extends its tail', () => {
    const state = harness();
    const commentary = snapshot('先检查代码', 'commentary');
    const patch: ClaudeMessage = { ...snapshot('', 'patch'), raw: {
      ...snapshot('', 'patch').raw as object,
      message: { content: [{ type: 'tool_use', id: 'patch', name: 'apply_patch', input: { patch: '*** Begin Patch\n*** End Patch' } }] },
    } };
    const following = snapshot('接着运行验证', 'following');
    window.updateMessages!(JSON.stringify([user, commentary, patch]), 1);
    window.updateMessageTail!(JSON.stringify([following]), 3, 2);

    expect(state.getMessages().map(message => typeof message.raw === 'object' ? message.raw?.codexItemId : undefined))
      .toEqual([undefined, 'commentary', 'patch', 'following']);
    vi.advanceTimersByTime(16);
    window.onStreamEnd!();
    expect(state.getMessages().filter(message => message.type === 'assistant')).toHaveLength(3);
  });
  it('retains earlier item corrections when a tail overtakes the buffered snapshot', () => {
    const state = harness();
    const first = snapshot('预览', 'commentary');
    const last = snapshot('正在检查', 'last');
    window.updateMessages!(JSON.stringify([user, first, last]), 1);
    vi.advanceTimersByTime(16);
    window.updateMessages!(JSON.stringify([user, snapshot('完整的中间说明', 'commentary'), last]), 2);
    window.updateMessageTail!(JSON.stringify([snapshot('检查完成', 'last')]), 2, 3);
    vi.advanceTimersByTime(16);

    expect(state.getMessages().map(message => message.content)).toEqual(['question', '完整的中间说明', '检查完成']);
  });
  it('preserves every native item when React batches a full snapshot, tail and stream end', () => {
    const { result } = renderHook(() => useState<ClaudeMessage[]>([user]), { reactStrictMode: true });
    harness(result.current[1]);
    const thinking: ClaudeMessage = { ...snapshot('', 'thinking'), raw: {
      ...snapshot('', 'thinking').raw as object,
      message: { content: [{ type: 'thinking', thinking: '检查变更的影响' }] },
    } };
    const patch: ClaudeMessage = { ...snapshot('', 'patch'), raw: {
      ...snapshot('', 'patch').raw as object,
      message: { content: [{ type: 'tool_use', id: 'patch', name: 'apply_patch', input: { patch: '*** Begin Patch\n*** End Patch' } }] },
    } };
    act(() => {
      window.updateMessages!(JSON.stringify([user, snapshot('预览', 'commentary'), thinking]), 1);
      vi.advanceTimersByTime(16);
    });
    act(() => {
      window.updateMessages!(JSON.stringify([user, snapshot('完整说明', 'commentary'), thinking, patch]), 2);
      window.updateMessageTail!(JSON.stringify([snapshot('验证完成')]), 4, 3);
      window.onStreamEnd!('4');
      vi.advanceTimersByTime(16);
    });

    expect(result.current[0].map(message => message.content)).toEqual(['question', '完整说明', '', '', '验证完成']);
    expect(result.current[0][2].raw).toMatchObject({ message: { content: [{ type: 'thinking', thinking: '检查变更的影响' }] } });
    expect(result.current[0][3].raw).toMatchObject({ message: { content: [{ type: 'tool_use', name: 'apply_patch' }] } });
    expect(result.current[0].some(message => message.isStreaming)).toBe(false);
  });
});
