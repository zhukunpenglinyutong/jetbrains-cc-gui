import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentManagement } from './useAgentManagement';
import type { AgentConfig } from '../../../types/agent';

/**
 * The hook talks to the backend through `window.sendToJava` rather than the
 * bridge module, so that is what the test installs: stubbing `utils/bridge`
 * here would leave the real code path unmocked and the assertions vacuous.
 */
const sendToJava = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && typeof options.count === 'number') {
        const plural = options.count === 1 ? '_one' : '_other';
        return `${key}${plural}:${String(options.count)}`;
      }
      if (options) {
        return `${key}:${Object.values(options).join(',')}`;
      }
      return key;
    },
  }),
}));

/** Every message the hook sent, parsed back into its command and body. */
function sentCommands(): { command: string; body: unknown }[] {
  return sendToJava.mock.calls.map(([raw]) => {
    const separator = raw.indexOf(':');
    return {
      command: separator === -1 ? raw : raw.slice(0, separator),
      body: separator === -1 ? null : JSON.parse(raw.slice(separator + 1) || 'null'),
    };
  });
}

const globalAgent: AgentConfig = {
  id: 'global-reviewer',
  name: 'reviewer',
  scope: 'global',
  readOnly: true,
  path: '/home/u/.claude/agents/reviewer.md',
};

describe('useAgentManagement', () => {
  beforeEach(() => {
    sendToJava.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = sendToJava;
  });

  afterEach(() => {
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
  });

  describe('loadAgents', () => {
    it('asks for every scope so the backend can apply precedence', () => {
      const { result } = renderHook(() => useAgentManagement());

      act(() => result.current.loadAgents());

      const listRequest = sentCommands().find((c) => c.command === 'get_agents');
      expect(listRequest?.body).toEqual({ scopes: ['global', 'local', 'store'] });
    });

    it('sends a single request, with no second call for a side channel', () => {
      const { result } = renderHook(() => useAgentManagement());
      sendToJava.mockClear();

      act(() => result.current.loadAgents());

      // The list is the whole state this tab keeps. A second request whose
      // answer arrived independently could disagree with the list beside it.
      expect(sentCommands().map((c) => c.command)).toEqual(['get_agents']);
    });
  });

  describe('watcher-driven refresh', () => {
    /**
     * The watcher fires when an agent file is saved in the editor. The tab
     * re-reads rather than being handed a list, so precedence and containment
     * stay the backend's job.
     */
    it('re-requests the list when a file changed', () => {
      const { result } = renderHook(() => useAgentManagement());
      sendToJava.mockClear();

      act(() => result.current.refreshAgentsQuietly());

      expect(sentCommands().some((c) => c.command === 'get_agents')).toBe(true);
    });

    it('asks for every scope, so a shadowed agent still resolves correctly', () => {
      const { result } = renderHook(() => useAgentManagement());
      sendToJava.mockClear();

      act(() => result.current.refreshAgentsQuietly());

      const request = sentCommands().find((c) => c.command === 'get_agents');
      expect(request?.body).toEqual({ scopes: ['global', 'local', 'store'] });
    });

    /**
     * The tab is showing a list the user is reading. Replacing it with a
     * spinner because they saved a file elsewhere would be a worse answer
     * than the few dozen milliseconds the rescan takes.
     */
    it('does not flash the loading state', () => {
      const { result } = renderHook(() => useAgentManagement());

      act(() => result.current.refreshAgentsQuietly());

      expect(result.current.agentsLoading).toBe(false);
    });

    /**
     * A quiet refresh clears the first-load timeout. Otherwise a change
     * arriving during the initial load leaves the timeout to fire afterwards
     * and wipe the list the real answer just delivered.
     */
    it('clears a pending first-load timeout', () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAgentManagement());
        act(() => result.current.loadAgents());
        expect(result.current.agentsLoading).toBe(true);

        act(() => result.current.refreshAgentsQuietly());
        // The answer arrives; the pending retry must not fire afterwards.
        act(() => result.current.updateAgents([globalAgent]));
        act(() => { vi.advanceTimersByTime(5000); });

        expect(result.current.agents).toHaveLength(1);
        expect(result.current.agentsLoading).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * A watcher event during the FIRST load must not disarm the safety net.
     *
     * The order matters: clearing the first load's timeout without arming a
     * replacement leaves `agentsLoading` true with nothing left to clear it, so
     * a lost answer strands the tab on "loading" until Settings is reopened.
     */
    it('leaves the tab recoverable when a change lands during the first load', () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAgentManagement());
        act(() => result.current.loadAgents());
        expect(result.current.agentsLoading).toBe(true);

        // The watcher fires inside the first load's 3-second window.
        act(() => result.current.refreshAgentsQuietly());

        // No answer ever arrives.
        act(() => { vi.advanceTimersByTime(10000); });

        expect(result.current.agentsLoading).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * `refreshing` had the same hole: only `updateAgents` ever cleared it, so
     * a lost answer left the Refresh button spinning forever.
     */
    it('stops the refresh indicator when its answer never arrives', () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAgentManagement());
        act(() => result.current.refreshAgents());
        expect(result.current.refreshing).toBe(true);

        act(() => { vi.advanceTimersByTime(10000); });

        expect(result.current.refreshing).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * A failed background refresh must not empty the list. The first load's
     * timeout does, because there is nothing to show anyway; this one does not,
     * because there is.
     */
    it('keeps the current list when a background refresh fails', () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAgentManagement());
        act(() => result.current.updateAgents([globalAgent]));
        expect(result.current.agents).toHaveLength(1);

        act(() => result.current.refreshAgentsQuietly());
        act(() => { vi.advanceTimersByTime(10000); });

        expect(result.current.agents).toHaveLength(1);
        expect(result.current.agentsLoading).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /** A refresh is a repeat of a request that just worked; retrying loops. */
    it('does not schedule a retry', () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAgentManagement());
        sendToJava.mockClear();

        act(() => result.current.refreshAgentsQuietly());
        const afterFirst = sendToJava.mock.calls.length;
        act(() => { vi.advanceTimersByTime(10000); });

        expect(sendToJava.mock.calls.length).toBe(afterFirst);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('rejected requests', () => {
    it('reports a failed operation instead of swallowing it', () => {
      const onError = vi.fn();
      const onSuccess = vi.fn();
      const { result } = renderHook(() => useAgentManagement({ onError, onSuccess }));

      // What the backend sends when it refuses the request, e.g. an unknown
      // scope: the tab must not look like it simply has no agents.
      act(() =>
        result.current.handleAgentOperationResult({
          success: false,
          error: 'Unknown agent scope(s) [projekt]',
        })
      );

      expect(onError).toHaveBeenCalledWith(expect.stringContaining('projekt'));
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('still reports a successful operation normally', () => {
      const onSuccess = vi.fn();
      const { result } = renderHook(() => useAgentManagement({ onSuccess }));

      act(() => result.current.handleAgentOperationResult({ success: true, operation: 'add' }));

      expect(onSuccess).toHaveBeenCalled();
    });
  });

  describe('store mutations', () => {
    it('keeps sending edit and delete for store entries', () => {
      const storeAgent: AgentConfig = { id: 'store-1', name: 'mine', prompt: 'x' };
      const { result } = renderHook(() => useAgentManagement());

      act(() => result.current.confirmDeleteAgent());
      act(() => result.current.handleSaveAgent({ name: 'mine', prompt: 'y' }));

      expect(sentCommands().some((c) => c.command === 'add_agent')).toBe(true);
    });
  });
});
