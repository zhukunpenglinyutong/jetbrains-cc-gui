import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentInfo } from '../types';
import {
  MAX_CODEX_SUBAGENT_STATUS_TARGETS,
  useCodexSubagentStatusPolling,
} from './useCodexSubagentStatusPolling';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

const runningAgent = (id: string): SubagentInfo => ({
  id,
  type: 'review',
  description: '',
  status: 'running',
  isAsync: true,
  messageIndex: 1,
  agentPath: `/root/${id}`,
});

describe('useCodexSubagentStatusPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendBridgeEventMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses one immediate batch request and one shared polling timer', () => {
    renderHook(() => useCodexSubagentStatusPolling({
      subagents: [runningAgent('call-1'), runningAgent('call-2')],
      currentSessionId: 'session-1',
      currentProvider: 'codex',
    }));

    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
    const [, payload] = sendBridgeEventMock.mock.calls[0];
    expect(JSON.parse(String(payload)).agents).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll Claude or terminal subagents', () => {
    const terminal = { ...runningAgent('call-1'), status: 'completed' as const };
    renderHook(() => useCodexSubagentStatusPolling({
      subagents: [terminal],
      currentSessionId: 'session-1',
      currentProvider: 'codex',
    }));
    renderHook(() => useCodexSubagentStatusPolling({
      subagents: [runningAgent('call-2')],
      currentSessionId: 'session-1',
      currentProvider: 'claude',
    }));

    expect(sendBridgeEventMock).not.toHaveBeenCalled();
  });

  it('bounds the number of agents in a batch', () => {
    const subagents = Array.from(
      { length: MAX_CODEX_SUBAGENT_STATUS_TARGETS + 3 },
      (_, index) => runningAgent(`call-${index}`),
    );
    renderHook(() => useCodexSubagentStatusPolling({
      subagents,
      currentSessionId: 'session-1',
      currentProvider: 'codex',
    }));

    const [, payload] = sendBridgeEventMock.mock.calls[0];
    expect(JSON.parse(String(payload)).agents).toHaveLength(MAX_CODEX_SUBAGENT_STATUS_TARGETS);
  });
});
