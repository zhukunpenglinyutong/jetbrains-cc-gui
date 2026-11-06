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

  it('forwards the completed-turn baseline on every poll of the current native task', () => {
    renderHook(() => useCodexSubagentStatusPolling({
      subagents: [{ ...runningAgent('launch'), nativeTaskId: 'followup', nativeTaskPreviousTurnId: 'previous-turn' }],
      currentSessionId: 'session-1', currentProvider: 'codex',
    }));
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
  });

  describe('Story 1.11: Gemini polling', () => {
    it('AC4: polls running Gemini subagents with agentId every 2 seconds', () => {
      const geminiSubagent = (id: string, agentId?: string): SubagentInfo => ({
        id,
        type: 'Full-Stack Developer',
        description: 'Test',
        status: 'running',
        isAsync: true,
        messageIndex: 1,
        agentId,
      });

      renderHook(() =>
        useCodexSubagentStatusPolling({
          subagents: [
            geminiSubagent('call-1', 'ac5686b0-9ad8-4a25-b988-14b42f175f7f'),
            geminiSubagent('call-2-no-id'), // No agentId — should not be polled
          ],
          currentSessionId: 'gemini-parent-session',
          currentProvider: 'gemini',
        }),
      );

      expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
      const [eventName, payload] = sendBridgeEventMock.mock.calls[0];
      expect(eventName).toBe('load_subagent_statuses');
      const parsed = JSON.parse(String(payload));
      expect(parsed).toMatchObject({
        sessionId: 'gemini-parent-session',
        provider: 'gemini',
      });
      expect(parsed.agents).toEqual([
        { toolUseId: 'call-1', agentId: 'ac5686b0-9ad8-4a25-b988-14b42f175f7f' },
      ]);

      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(2);
    });

    it('AC4: caps at 64 running Gemini agents', () => {
      const subagents = Array.from({ length: 70 }, (_, index) => ({
        id: `call-${index}`,
        type: 'Dev',
        description: '',
        status: 'running' as const,
        isAsync: true,
        messageIndex: 1,
        agentId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }));

      renderHook(() =>
        useCodexSubagentStatusPolling({
          subagents,
          currentSessionId: 'gemini-session',
          currentProvider: 'gemini',
        }),
      );

      const [, payload] = sendBridgeEventMock.mock.calls[0];
      expect(JSON.parse(String(payload)).agents).toHaveLength(64);
    });
  });
});
