import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchNodeProcesses,
  installNodeProcessDispatchers,
  killAllOrphanProcesses,
  killNodeProcess,
  restartNodeDaemon,
  subscribeNodeProcessKillResult,
  subscribeNodeProcesses,
  type NodeProcessSnapshot,
} from './nodeProcessCapabilities';

describe('nodeProcessCapabilities', () => {
  let sentMessages: string[] = [];

  beforeEach(() => {
    sentMessages = [];
    window.sendToJava = (message: string) => {
      sentMessages.push(message);
    };
    // Reinstall dispatchers fresh so each test starts with no stale window callbacks
    installNodeProcessDispatchers();
  });

  afterEach(() => {
    delete (window as { sendToJava?: unknown }).sendToJava;
    delete (window as { updateNodeProcesses?: unknown }).updateNodeProcesses;
    delete (window as { nodeProcessKillResult?: unknown }).nodeProcessKillResult;
  });

  describe('bridge events', () => {
    it('fetchNodeProcesses sends get_node_processes event', () => {
      fetchNodeProcesses();
      expect(sentMessages).toEqual(['get_node_processes:']);
    });

    it('killNodeProcess sends pid payload', () => {
      killNodeProcess(12345);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatch(/^kill_node_process:/);
      const payload = JSON.parse(sentMessages[0].substring('kill_node_process:'.length));
      expect(payload).toEqual({ pid: 12345 });
    });

    it('killNodeProcess includes id when provided', () => {
      killNodeProcess(12345, 'daemon-claude-12345');
      const payload = JSON.parse(sentMessages[0].substring('kill_node_process:'.length));
      expect(payload).toEqual({ pid: 12345, id: 'daemon-claude-12345' });
    });

    it('killAllOrphanProcesses sends kill_all_orphans event', () => {
      killAllOrphanProcesses();
      expect(sentMessages).toEqual(['kill_all_orphans:']);
    });

    it('restartNodeDaemon sends pid payload', () => {
      restartNodeDaemon(987);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatch(/^restart_node_daemon:/);
      const payload = JSON.parse(sentMessages[0].substring('restart_node_daemon:'.length));
      expect(payload).toEqual({ pid: 987 });
    });
  });

  describe('subscriber dispatch', () => {
    it('routes window.updateNodeProcesses payloads to all snapshot subscribers', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = subscribeNodeProcesses(listener1);
      const unsub2 = subscribeNodeProcesses(listener2);

      const snapshot: NodeProcessSnapshot = {
        snapshotAt: 1234,
        totals: { daemon: 1, channel: 0, orphan: 0, all: 1 },
        processes: [{
          id: 'daemon-claude-1',
          kind: 'DAEMON',
          provider: 'claude',
          pid: 1,
          alive: true,
          startedAt: 1000,
          uptimeMs: 234,
          activeRequestCount: 0,
          orphan: false,
        }],
      };
      window.updateNodeProcesses!(JSON.stringify(snapshot));

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
      expect(listener1.mock.calls[0][0]).toEqual(snapshot);

      unsub1();
      window.updateNodeProcesses!(JSON.stringify(snapshot));
      expect(listener1).toHaveBeenCalledTimes(1); // unchanged
      expect(listener2).toHaveBeenCalledTimes(2); // received again

      unsub2();
    });

    it('routes window.nodeProcessKillResult payloads to kill subscribers', () => {
      const listener = vi.fn();
      const unsub = subscribeNodeProcessKillResult(listener);

      window.nodeProcessKillResult!(JSON.stringify({ pid: 1, success: true }));
      window.nodeProcessKillResult!(JSON.stringify({ killed: 3 }));

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[0][0]).toEqual({ pid: 1, success: true });
      expect(listener.mock.calls[1][0]).toEqual({ killed: 3 });
      unsub();
    });

    it('silently drops malformed snapshot JSON (does not throw)', () => {
      const listener = vi.fn();
      const unsub = subscribeNodeProcesses(listener);

      expect(() => window.updateNodeProcesses!('this-is-not-json')).not.toThrow();
      expect(listener).not.toHaveBeenCalled();

      // Also reject payloads that are JSON but missing the processes array
      expect(() => window.updateNodeProcesses!('{"totals":{}}')).not.toThrow();
      expect(listener).not.toHaveBeenCalled();
      unsub();
    });

    it('silently drops malformed kill result JSON', () => {
      const listener = vi.fn();
      const unsub = subscribeNodeProcessKillResult(listener);
      expect(() => window.nodeProcessKillResult!('{invalid')).not.toThrow();
      expect(listener).not.toHaveBeenCalled();
      unsub();
    });

    it('isolates a throwing listener from peer listeners', () => {
      const throwing = vi.fn(() => { throw new Error('boom'); });
      const survivor = vi.fn();
      const unsub1 = subscribeNodeProcesses(throwing);
      const unsub2 = subscribeNodeProcesses(survivor);

      const snapshot: NodeProcessSnapshot = {
        snapshotAt: 1, totals: { daemon: 0, channel: 0, orphan: 0, all: 0 }, processes: [],
      };
      // No exception should propagate out
      expect(() => window.updateNodeProcesses!(JSON.stringify(snapshot))).not.toThrow();

      expect(throwing).toHaveBeenCalledTimes(1);
      expect(survivor).toHaveBeenCalledTimes(1);
      unsub1();
      unsub2();
    });
  });
});
