import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentInfo } from '../types';
import {
  MAX_CODEX_SUBAGENT_STATUS_TARGETS,
  CODEX_SUBAGENT_STATUS_TIMEOUT_MS,
  useCodexSubagentStatusPolling,
} from './useCodexSubagentStatusPolling';
import { CODEX_SUBAGENT_STATUS_SETTLED_EVENT } from '../utils/codexStatusRequestTracker';

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

function acknowledgeLastRequest(extra: Record<string, unknown> = {}) {
  const request = JSON.parse(String(sendBridgeEventMock.mock.calls.at(-1)![1]));
  act(() => window.dispatchEvent(new CustomEvent(CODEX_SUBAGENT_STATUS_SETTLED_EVENT, {
    detail: { requestId: request.requestId, sessionId: request.sessionId, provider: 'codex', ...extra },
  })));
}

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

    acknowledgeLastRequest();
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

  it('forwards the completed-turn baseline on every poll of the current native task', () => {
    renderHook(() => useCodexSubagentStatusPolling({
      subagents: [{ ...runningAgent('launch'), nativeTaskId: 'followup', nativeTaskPreviousTurnId: 'previous-turn' }],
      currentSessionId: 'session-1', currentProvider: 'codex',
    }));
    acknowledgeLastRequest();
    act(() => vi.advanceTimersByTime(2_000));
    for (const [, payload] of sendBridgeEventMock.mock.calls) {
      expect(JSON.parse(String(payload)).agents[0]).toMatchObject({
        nativeTaskId: 'followup', nativeTaskPreviousTurnId: 'previous-turn',
      });
    }
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
    acknowledgeLastRequest();
    act(() => vi.advanceTimersByTime(2_000));
    const next = JSON.parse(String(sendBridgeEventMock.mock.calls[1][1]));
    expect(next.agents.map((agent: { toolUseId: string }) => agent.toolUseId))
      .toEqual(['call-64', 'call-65', 'call-66']);
    acknowledgeLastRequest();
    act(() => vi.advanceTimersByTime(2_000));
    expect(JSON.parse(String(sendBridgeEventMock.mock.calls[2][1])).agents[0].toolUseId).toBe('call-0');
  });

  it('reaches every child in a large fanout and resets rotation for another session', () => {
    const subagents = Array.from({ length: 257 }, (_, index) => runningAgent(`child-${index}`));
    const { rerender } = renderHook(({ sessionId }) => useCodexSubagentStatusPolling({
      subagents, currentSessionId: sessionId, currentProvider: 'codex',
    }), { initialProps: { sessionId: 'first' } });
    for (let index = 0; index < 4; index++) {
      acknowledgeLastRequest();
      act(() => vi.advanceTimersByTime(2_000));
    }
    const batches = sendBridgeEventMock.mock.calls.map(([, payload]) => JSON.parse(String(payload)).agents as { toolUseId: string }[]);
    expect(batches.every(batch => batch.length <= MAX_CODEX_SUBAGENT_STATUS_TARGETS)).toBe(true);
    expect(new Set(batches.flat().map(agent => agent.toolUseId)).size).toBe(257);
    rerender({ sessionId: 'second' });
    expect(JSON.parse(String(sendBridgeEventMock.mock.calls.at(-1)![1])).agents[0].toolUseId).toBe('child-0');
  });

  it('waits for slow batches across rerenders and advances after busy/error responses', () => {
    const subagents = Array.from({ length: 257 }, (_, index) => runningAgent(`child-${index}`));
    const { rerender } = renderHook(({ agents }) => useCodexSubagentStatusPolling({
      subagents: agents, currentSessionId: 'slow', currentProvider: 'codex',
    }), { initialProps: { agents: subagents } });
    act(() => vi.advanceTimersByTime(8_000));
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
    rerender({ agents: [...subagents, runningAgent('new-child')] });
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
    acknowledgeLastRequest();
    act(() => vi.advanceTimersByTime(2_000));
    expect(JSON.parse(String(sendBridgeEventMock.mock.calls.at(-1)![1])).agents[0].toolUseId).toBe('child-64');
    acknowledgeLastRequest({ error: 'Status request already running' });
    act(() => vi.advanceTimersByTime(2_000));
    expect(JSON.parse(String(sendBridgeEventMock.mock.calls.at(-1)![1])).agents[0].toolUseId).toBe('child-128');
    // A stale completion cannot release this newest pending request.
    act(() => window.dispatchEvent(new CustomEvent(CODEX_SUBAGENT_STATUS_SETTLED_EVENT, {
      detail: { sessionId: 'slow', provider: 'codex', requestId: 'slow:1' },
    })));
    act(() => vi.advanceTimersByTime(2_000));
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(3);
  });

  it('releases a lost callback after an observation timeout without stopping native tasks', () => {
    renderHook(() => useCodexSubagentStatusPolling({ subagents: Array.from({ length: 80 }, (_, index) => runningAgent(`child-${index}`)),
      currentSessionId: 'timeout', currentProvider: 'codex' }));
    act(() => vi.advanceTimersByTime(CODEX_SUBAGENT_STATUS_TIMEOUT_MS - 1));
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2_000));
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(sendBridgeEventMock.mock.calls[1][1])).agents[0].toolUseId).toBe('child-64');
    expect(sendBridgeEventMock.mock.calls.every(([event]) => event === 'load_subagent_statuses')).toBe(true);
  });
});
