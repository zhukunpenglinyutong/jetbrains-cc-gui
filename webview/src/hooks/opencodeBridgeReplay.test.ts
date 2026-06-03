import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { useStreamingMessages } from './useStreamingMessages';
import { useWindowCallbacks } from './useWindowCallbacks';
import type { UseWindowCallbacksOptions } from './useWindowCallbacks';
import type { ClaudeMessage } from '../types';

const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), '../test-fixtures/opencode/role-gated-tool-boundary.json'),
  'utf8',
));

function installSynchronousBridgeTimers() {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => {
    now += 100;
    return now;
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    now += 100;
    callback(now);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('setTimeout', (callback: () => void) => {
    callback();
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  vi.stubGlobal('clearTimeout', vi.fn());
  vi.stubGlobal('setInterval', vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>));
  vi.stubGlobal('clearInterval', vi.fn());
}

function bridgeMessageToClaudeMessage(payload: any): ClaudeMessage | null {
  if (!payload || payload.type === 'status') {
    return null;
  }
  const content = Array.isArray(payload.message?.content) ? payload.message.content : [];
  const text = content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('');
  const isToolResultOnly = content.length > 0 && content.every((block: any) => block?.type === 'tool_result');
  return {
    type: payload.type,
    content: text || (isToolResultOnly ? '[tool_result]' : ''),
    timestamp: '2026-06-03T00:00:00.000Z',
    raw: { message: payload.message } as any,
  } as ClaudeMessage;
}

function rawBlocks(message: ClaudeMessage | undefined): any[] {
  const raw = message?.raw as any;
  const blocks = raw?.message?.content ?? raw?.content;
  return Array.isArray(blocks) ? blocks : [];
}

function createReplayHarness() {
  const messages = { current: [] as ClaudeMessage[] };
  const backendMessages: ClaudeMessage[] = [];
  const streaming = renderHook(() => useStreamingMessages());
  const setMessages = vi.fn((value: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
    messages.current = typeof value === 'function'
      ? (value as (prev: ClaudeMessage[]) => ClaudeMessage[])(messages.current)
      : value;
  });

  const stream = streaming.result.current;
  const options = {
    t: ((key: string) => key) as any,
    addToast: vi.fn(),
    clearToasts: vi.fn(),
    setMessages,
    setStatus: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setIsThinking: vi.fn(),
    setExpandedThinking: vi.fn(),
    setStreamingActive: vi.fn(),
    setHistoryData: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setCustomSessionTitle: vi.fn(),
    setUsagePercentage: vi.fn(),
    setUsageUsedTokens: vi.fn(),
    setUsageMaxTokens: vi.fn(),
    setSubagentHistories: vi.fn(),
    setPermissionMode: vi.fn(),
    setClaudePermissionMode: vi.fn(),
    setCodexPermissionMode: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setProviderConfigVersion: vi.fn(),
    setActiveProviderConfig: vi.fn(),
    setClaudeSettingsAlwaysThinkingEnabled: vi.fn(),
    setStreamingEnabledSetting: vi.fn(),
    setSendShortcut: vi.fn(),
    setAutoOpenFileEnabled: vi.fn(),
    setPermissionDialogTimeoutSeconds: vi.fn(),
    setSdkStatus: vi.fn(),
    setSdkStatusLoaded: vi.fn(),
    setIsRewinding: vi.fn(),
    setRewindDialogOpen: vi.fn(),
    setCurrentRewindRequest: vi.fn(),
    setContextInfo: vi.fn(),
    setAgentsByProvider: vi.fn(),
    currentProviderRef: { current: 'opencode' },
    messagesContainerRef: { current: null },
    isUserAtBottomRef: { current: true },
    userPausedRef: { current: false },
    suppressNextStatusToastRef: { current: false },
    streamingContentRef: stream.streamingContentRef,
    streamingThinkingRef: stream.streamingThinkingRef,
    isStreamingRef: stream.isStreamingRef,
    useBackendStreamingRenderRef: stream.useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef: stream.autoExpandedThinkingKeysRef,
    streamingMessageIndexRef: stream.streamingMessageIndexRef,
    streamingTurnIdRef: stream.streamingTurnIdRef,
    turnIdCounterRef: stream.turnIdCounterRef,
    lastContentUpdateRef: stream.lastContentUpdateRef,
    contentUpdateTimeoutRef: stream.contentUpdateTimeoutRef,
    lastThinkingUpdateRef: stream.lastThinkingUpdateRef,
    thinkingUpdateTimeoutRef: stream.thinkingUpdateTimeoutRef,
    findLastAssistantIndex: stream.findLastAssistantIndex,
    extractRawBlocks: stream.extractRawBlocks,
    getOrCreateStreamingAssistantIndex: stream.getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming: stream.patchAssistantForStreaming,
    markStreamingBlockBoundary: stream.markStreamingBlockBoundary,
    resetStreamingBlockBoundary: stream.resetStreamingBlockBoundary,
    syncActiveProviderModelMapping: vi.fn(),
    openPermissionDialog: vi.fn(),
    openAskUserQuestionDialog: vi.fn(),
    openPlanApprovalDialog: vi.fn(),
    openContextUsageDialog: vi.fn(),
    updateContextUsageData: vi.fn(),
    closeContextUsageDialog: vi.fn(),
    customSessionTitleRef: { current: null },
    currentSessionIdRef: { current: null },
    updateHistoryTitle: vi.fn(),
    applyHistoryTitleLocal: vi.fn(),
  } as unknown as UseWindowCallbacksOptions;

  renderHook(() => useWindowCallbacks(options));

  function replayMarker(marker: any) {
    switch (marker.type) {
      case 'STREAM_START':
        act(() => { window.onStreamStart?.(); });
        break;
      case 'CONTENT_DELTA':
        act(() => { window.onContentDelta?.(marker.payload); });
        break;
      case 'THINKING_DELTA':
        act(() => { window.onThinkingDelta?.(marker.payload); });
        break;
      case 'BLOCK_RESET':
        act(() => { window.onBlockReset?.(); });
        break;
      case 'STREAM_END':
        act(() => { window.onStreamEnd?.('100'); });
        break;
      case 'MESSAGE': {
        const message = bridgeMessageToClaudeMessage(marker.payload);
        if (message) {
          backendMessages.push(message);
          act(() => { window.updateMessages?.(JSON.stringify(backendMessages)); });
        }
        break;
      }
      default:
        throw new Error(`Unknown replay marker: ${marker.type}`);
    }
  }

  return { messages, replayMarker };
}

describe('opencode bridge marker replay', () => {
  beforeEach(() => {
    installSynchronousBridgeTimers();
    window.__sessionTransitioning = false;
    window.__sessionTransitionToken = null;
    window.__deniedToolIds = new Set();
    window.sendToJava = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders text, thinking, tool, result, and post-tool text from replay markers', () => {
    const { messages, replayMarker } = createReplayHarness();

    for (const marker of fixture.expect.webviewReplay) {
      replayMarker(marker);
    }

    const assistant = messages.current.find((message) => message.type === 'assistant');
    const user = messages.current.find((message) => message.type === 'user');
    const blocks = rawBlocks(assistant);
    const blockTypes = blocks.map((block) => block.type);

    expect(messages.current.map((message) => message.type)).toEqual(['assistant', 'user']);
    expect(blockTypes).toEqual(['thinking', 'text', 'tool_use', 'text']);
    expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'Need tool.' });
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'Before tool.' });
    expect(blocks[2]).toMatchObject({ type: 'tool_use', id: 'call_1' });
    expect(blocks[3]).toMatchObject({ type: 'text', text: ' After tool.' });
    expect(rawBlocks(user)[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    expect(JSON.stringify(messages.current)).not.toContain('Echoed prompt');
  });
});
