import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeMessage } from '../../../types';
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

function harness() {
  let messages = [user];
  const options = {
    currentProviderRef: ref('codex'), currentSessionIdRef: ref('thread'),
    streamingContentRef: ref(''), streamingThinkingRef: ref(''), isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false), streamingMessageIndexRef: ref(-1), streamingTurnIdRef: ref(-1),
    turnIdCounterRef: ref(0), autoExpandedThinkingKeysRef: ref(new Set()),
    lastContentUpdateRef: ref(0), lastThinkingUpdateRef: ref(0),
    contentUpdateTimeoutRef: ref(null), thinkingUpdateTimeoutRef: ref(null),
    setMessages: (next: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next;
    },
    findLastAssistantIndex: (list: ClaudeMessage[]) => list.reduce((last, message, index) => message.type === 'assistant' ? index : last, -1),
    extractRawBlocks: (raw: ClaudeMessage['raw']) => typeof raw === 'object' ? raw?.message?.content ?? [] : [],
    patchAssistantForStreaming: (message: ClaudeMessage) => message,
    setStreamingActive: vi.fn(), setLoading: vi.fn(), setLoadingStartTime: vi.fn(), setIsThinking: vi.fn(),
    setExpandedThinking: vi.fn(), addToast: vi.fn(), setStatus: vi.fn(), setHistoryData: vi.fn(),
    getOrCreateStreamingAssistantIndex: () => -1,
  } as unknown as UseWindowCallbacksOptions;
  registerMessageCallbacks(options, vi.fn(), vi.fn());
  registerStreamingCallbacks(options);
  window.onStreamStart!();
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
});
