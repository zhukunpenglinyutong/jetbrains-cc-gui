import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '../types';
import type { CacheKeys } from '../types';
import { readCache, readToolsCache, writeCache, writeToolsCache } from '../utils';
import { getServerCardKey } from '../serverCardKey';
import { useServerData } from './useServerData';
import { useToolsUpdate } from './useToolsUpdate';

const sendToJavaMock = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/bridge', () => ({
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
}));

const cacheKeys: CacheKeys = {
  SERVERS: 'test.mcp.servers',
  STATUS: 'test.mcp.status',
  TOOLS: 'test.mcp.tools',
  LAST_SERVER_ID: 'test.mcp.last-server',
};

const server: McpServer = {
  id: 'server-a',
  name: 'Primary Server',
  server: { command: 'node' },
};

const otherServer: McpServer = {
  id: 'server-b',
  name: 'Other Server',
  server: { command: 'node' },
};

// A project-local .mcp.json entry that collides with `server`: the backend keeps both
// records and leaves `id` on each, flagging the project one as conflicting.
const projectTwin: McpServer = {
  id: 'server-a',
  name: 'Primary Server',
  server: { command: 'node' },
  source: 'project',
  conflicting: true,
  conflictingWith: 'global',
};

const translate = (key: string) => key;
const onLog = vi.fn();

function renderServerData() {
  return renderHook(() => useServerData({
    isCodexMode: false,
    messagePrefix: '',
    cacheKeys,
    t: translate,
    onLog,
  }));
}

beforeEach(() => {
  localStorage.clear();
  sendToJavaMock.mockClear();
  onLog.mockClear();
});

afterEach(() => {
  delete window.updateMcpServers;
  delete window.updateMcpServerStatus;
  delete window.updateMcpServerStatusPartial;
  delete window.updateMcpServerTools;
  delete window.updateCodexMcpServers;
  delete window.updateCodexMcpServerStatus;
  delete window.updateCodexMcpServerTools;
  delete window.refreshMcpServers;
});

describe('useServerData terminal MCP status handling', () => {
  it('clears runtime and persisted tools when a matching server fails', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server]));
      hook.result.current.setServerTools({
        [getServerCardKey(server)]: { tools: [{ name: 'stale-tool' }], loading: false },
      });
      writeToolsCache(server.id, [{ name: 'stale-tool' }], cacheKeys);
    });

    act(() => {
      window.updateMcpServerStatus?.(JSON.stringify([{
        name: server.name,
        status: 'failed',
      }]));
    });

    expect(hook.result.current.serverTools[getServerCardKey(server)]).toBeUndefined();
    expect(readToolsCache(server.id, cacheKeys)).toBeNull();
  });

  it('clears cached tools when terminal status arrives before the server list', () => {
    const hook = renderServerData();
    writeToolsCache(server.id, [{ name: 'stale-tool' }], cacheKeys);

    act(() => {
      window.updateMcpServerStatus?.(JSON.stringify([{
        name: server.name,
        status: 'needs-auth',
      }]));
    });

    expect(readToolsCache(server.id, cacheKeys)).not.toBeNull();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server]));
    });

    expect(readToolsCache(server.id, cacheKeys)).toBeNull();
    hook.unmount();
  });

  it('does not restore tools cached for a terminal server during startup', () => {
    writeCache(cacheKeys.SERVERS, [server]);
    writeCache(cacheKeys.STATUS, [{
      name: server.name,
      status: 'disabled',
    }]);
    writeToolsCache(server.id, [{ name: 'stale-tool' }], cacheKeys);

    const hook = renderServerData();

    expect(hook.result.current.serverTools[getServerCardKey(server)]).toBeUndefined();
    expect(readToolsCache(server.id, cacheKeys)).toBeNull();
    hook.unmount();
  });
});

describe('useServerData server list cache', () => {
  it('keeps env and headers out of the persisted server cache', () => {
    const secretServer: McpServer = {
      id: 'server-secret',
      name: 'Secret Server',
      server: {
        command: 'node',
        env: { API_KEY: 'sk-live-should-never-be-cached' },
        headers: { Authorization: 'Bearer nope' },
      },
    };

    const hook = renderServerData();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([secretServer]));
    });

    const cached = readCache<McpServer[]>(cacheKeys.SERVERS, cacheKeys);
    expect(cached?.[0]?.server.env).toBeUndefined();
    expect(cached?.[0]?.server.headers).toBeUndefined();
    // The rest of the spec still has to be there for the list to be usable.
    expect(cached?.[0]?.server.command).toBe('node');
    // ...and the live state is untouched, so editing the server still shows its env.
    expect(hook.result.current.servers[0]?.server.env?.API_KEY).toBe('sk-live-should-never-be-cached');
    hook.unmount();
  });

  it('re-reads the server list from the backend after a cache hit', () => {
    writeCache(cacheKeys.SERVERS, [server]);

    const hook = renderServerData();

    // The cached copy is metadata-only, so the panel must not stay on it: a fresh
    // request brings back the env block without making the user wait for it.
    expect(sendToJavaMock).toHaveBeenCalledWith('get_mcp_servers', {});
    expect(sendToJavaMock).not.toHaveBeenCalledWith('get_mcp_server_status', {});
    hook.unmount();
  });
});

describe('useServerData refreshMcpServers callback', () => {
  it('reloads servers and status when refreshMcpServers is called', () => {
    const hook = renderServerData();
    // Hook initialization already triggers initial load; clear to isolate the refresh call
    sendToJavaMock.mockClear();

    act(() => {
      window.refreshMcpServers?.('{}');
    });

    expect(sendToJavaMock).toHaveBeenCalledWith('get_mcp_servers', {});
    expect(sendToJavaMock).toHaveBeenCalledWith('get_mcp_server_status', {});
    hook.unmount();
  });

  it('reloads only servers (not status) in codex mode', () => {
    const hook = renderHook(() => useServerData({
      isCodexMode: true,
      messagePrefix: 'codex_',
      cacheKeys,
      t: translate,
      onLog,
    }));
    sendToJavaMock.mockClear();

    act(() => {
      window.refreshMcpServers?.('{}');
    });

    expect(sendToJavaMock).toHaveBeenCalledWith('get_codex_mcp_servers', {});
    expect(sendToJavaMock).not.toHaveBeenCalledWith('get_codex_mcp_server_status', {});
    hook.unmount();
  });
});

describe('useServerData targeted status refresh', () => {
  it('sends the server filter and leaves the section spinner alone', () => {
    const hook = renderServerData();
    // The mount effect kicks off a full load, so settle that first: the assertion
    // is that a targeted refresh does not raise the spinner again.
    act(() => {
      window.updateMcpServerStatus?.(JSON.stringify([{ name: server.name, status: 'connected' }]));
    });
    expect(hook.result.current.statusLoading).toBe(false);
    sendToJavaMock.mockClear();

    act(() => {
      hook.result.current.loadServerStatus([server.id]);
    });

    expect(sendToJavaMock).toHaveBeenCalledWith('get_mcp_server_status', {
      serverNames: [server.id],
    });
    expect(hook.result.current.statusLoading).toBe(false);
    hook.unmount();
  });

  it('still requests every server and shows the spinner for a full refresh', () => {
    const hook = renderServerData();
    act(() => {
      window.updateMcpServerStatus?.(JSON.stringify([{ name: server.name, status: 'connected' }]));
    });
    sendToJavaMock.mockClear();

    act(() => {
      hook.result.current.loadServerStatus();
    });

    expect(sendToJavaMock).toHaveBeenCalledWith('get_mcp_server_status', {});
    expect(hook.result.current.statusLoading).toBe(true);
    hook.unmount();
  });

  it('merges a partial update without dropping the other servers', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server, otherServer]));
      window.updateMcpServerStatus?.(JSON.stringify([
        { name: server.name, status: 'pending' },
        { name: otherServer.name, status: 'connected' },
      ]));
    });

    act(() => {
      window.updateMcpServerStatusPartial?.(JSON.stringify([
        { name: server.name, status: 'connected' },
      ]));
    });

    // The requested server is updated...
    expect(hook.result.current.serverStatus.get(server.name ?? '')?.status).toBe('connected');
    // ...and the untouched one survives, which is the whole point of a partial update.
    expect(hook.result.current.serverStatus.get(otherServer.name ?? '')?.status).toBe('connected');
    hook.unmount();
  });

  it('merges a partial update into the status cache instead of overwriting it', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServerStatus?.(JSON.stringify([
        { name: server.name, status: 'pending' },
        { name: otherServer.name, status: 'connected' },
      ]));
      window.updateMcpServerStatusPartial?.(JSON.stringify([
        { name: server.name, status: 'failed' },
      ]));
    });

    // A one-entry cache would be restored as if it were the complete picture on the
    // next mount, leaving every other server without a status.
    const cached = readCache<{ name: string; status: string }[]>(cacheKeys.STATUS, cacheKeys);
    expect(cached?.map((entry) => entry.name).sort()).toEqual([
      otherServer.name,
      server.name,
    ].sort());
    expect(cached?.find((entry) => entry.name === server.name)?.status).toBe('failed');
    hook.unmount();
  });

  it('clears tools for the requested server when it comes back disabled', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server, otherServer]));
      hook.result.current.setServerTools({
        [getServerCardKey(server)]: { tools: [{ name: 'stale-tool' }], loading: false },
        [getServerCardKey(otherServer)]: { tools: [{ name: 'other-tool' }], loading: false },
      });
      writeToolsCache(server.id, [{ name: 'stale-tool' }], cacheKeys);
    });

    act(() => {
      window.updateMcpServerStatusPartial?.(JSON.stringify([
        { name: server.name, status: 'failed' },
      ]));
    });

    expect(hook.result.current.serverTools[getServerCardKey(server)]).toBeUndefined();
    expect(readToolsCache(server.id, cacheKeys)).toBeNull();
    // The unrelated server keeps its tools.
    expect(hook.result.current.serverTools[getServerCardKey(otherServer)]).toBeDefined();
    hook.unmount();
  });

  it('keeps existing statuses when a partial update returns nothing', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServerStatus?.(JSON.stringify([
        { name: server.name, status: 'connected' },
        { name: otherServer.name, status: 'connected' },
      ]));
    });

    act(() => {
      window.updateMcpServerStatusPartial?.(JSON.stringify([]));
    });

    expect(hook.result.current.serverStatus.size).toBe(2);
    hook.unmount();
  });

  it('drops the status of a requested server the response omits (rejected server)', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server, otherServer]));
      window.updateMcpServerStatus?.(JSON.stringify([
        { name: server.name, status: 'connected' },
        { name: otherServer.name, status: 'connected' },
      ]));
    });

    // Rejecting drops the server from the MCP config, so the bridge has no status for
    // it at all. Without the requested-name list the card would keep its green dot
    // until a full refresh replaced the whole map.
    act(() => {
      window.updateMcpServerStatusPartial?.(JSON.stringify([]), JSON.stringify([server.name]));
    });

    expect(hook.result.current.serverStatus.has(server.name ?? '')).toBe(false);
    expect(hook.result.current.serverStatus.get(otherServer.name ?? '')?.status).toBe('connected');

    const cached = readCache<{ name: string }[]>(cacheKeys.STATUS, cacheKeys);
    expect(cached?.map((entry) => entry.name)).toEqual([otherServer.name]);
    hook.unmount();
  });

  it('drops the status when a targeted check fails outright', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server]));
      window.updateMcpServerStatus?.(JSON.stringify([{ name: server.name, status: 'connected' }]));
    });

    // The backend routes the empty error response to the partial callback as well.
    act(() => {
      window.updateMcpServerStatusPartial?.(JSON.stringify([]), JSON.stringify([server.name]));
    });

    expect(hook.result.current.serverStatus.has(server.name ?? '')).toBe(false);
    hook.unmount();
  });

  it('never drops a status for a name that is not a known server', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server]));
      window.updateMcpServerStatus?.(JSON.stringify([{ name: server.name, status: 'connected' }]));
    });

    // window.updateMcpServerStatusPartial is reachable by any code in the view's
    // context, and its second argument feeds straight into a delete. An unknown
    // name must therefore be ignored rather than evicting a status entry.
    act(() => {
      window.updateMcpServerStatusPartial?.(JSON.stringify([]), JSON.stringify(['never-configured']));
    });

    expect(hook.result.current.serverStatus.get(server.name ?? '')?.status).toBe('connected');

    const cached = readCache<{ name: string }[]>(cacheKeys.STATUS, cacheKeys);
    expect(cached?.map((entry) => entry.name)).toEqual([server.name]);
    hook.unmount();
  });

  it('still merges when the backend sends no name list', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServerStatus?.(JSON.stringify([
        { name: server.name, status: 'pending' },
        { name: otherServer.name, status: 'connected' },
      ]));
    });

    act(() => {
      window.updateMcpServerStatusPartial?.(JSON.stringify([
        { name: server.name, status: 'connected' },
      ]));
    });

    expect(hook.result.current.serverStatus.get(server.name ?? '')?.status).toBe('connected');
    expect(hook.result.current.serverStatus.get(otherServer.name ?? '')?.status).toBe('connected');
    hook.unmount();
  });
});

describe('useServerData colliding server ids', () => {
  const globalKey = getServerCardKey(server);
  const projectKey = getServerCardKey(projectTwin);

  /** Also wires the bridge callback that actually delivers tools responses. */
  function renderColliding() {
    return renderHook(() => {
      const data = useServerData({
        isCodexMode: false,
        messagePrefix: '',
        cacheKeys,
        t: translate,
        onLog,
      });
      useToolsUpdate({
        isCodexMode: false,
        cacheKeys,
        setServerTools: data.setServerTools,
        onLog,
      });
      return data;
    });
  }

  function deliverTools(serverId: string, toolName: string) {
    act(() => {
      window.updateMcpServerTools?.(JSON.stringify({
        serverId,
        serverName: 'Primary Server',
        tools: [{ name: toolName }],
      }));
    });
  }

  it('gives two cards with the same id separate expansion and tool slots', () => {
    expect(globalKey).not.toBe(projectKey);

    const hook = renderColliding();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server, projectTwin]));
    });

    // The request still goes out under the real id — that is the backend identity.
    act(() => {
      hook.result.current.loadServerTools(server, false);
    });
    expect(sendToJavaMock).toHaveBeenCalledWith('get_mcp_server_tools', {
      serverId: 'server-a',
      forceRefresh: false,
    });
    deliverTools('server-a', 'global-tool');

    // The response lands in the slot of the card that asked for it...
    expect(hook.result.current.serverTools[globalKey]?.tools).toEqual([{ name: 'global-tool' }]);
    // ...and not in the slot of the card that shares its id.
    expect(hook.result.current.serverTools[projectKey]).toBeUndefined();

    act(() => {
      hook.result.current.loadServerTools(projectTwin, false);
    });
    deliverTools('server-a', 'project-tool');

    expect(hook.result.current.serverTools[projectKey]?.tools).toEqual([{ name: 'project-tool' }]);
    // The global card keeps its own list instead of being overwritten.
    expect(hook.result.current.serverTools[globalKey]?.tools).toEqual([{ name: 'global-tool' }]);
    hook.unmount();
  });

  it('routes the expansion of one colliding card to that card only', () => {
    const hook = renderColliding();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server, projectTwin]));
      hook.result.current.setExpandedServers(new Set([projectKey]));
    });

    // Expanding the project card must not open the global one, and must not be reachable
    // through the shared id.
    expect(hook.result.current.expandedServers.has(projectKey)).toBe(true);
    expect(hook.result.current.expandedServers.has(globalKey)).toBe(false);
    expect(hook.result.current.expandedServers.has('server-a')).toBe(false);
    hook.unmount();
  });

  it('skips the shared persisted tools cache when the id is ambiguous', () => {
    // The persisted tools cache is keyed by the backend id, so its entry cannot be
    // attributed to one of the two cards. The hook must ask the backend instead of
    // showing one card the other card's tools.
    writeToolsCache('server-a', [{ name: 'global-tool' }], cacheKeys);

    const hook = renderColliding();
    act(() => {
      window.updateMcpServers?.(JSON.stringify([server, projectTwin]));
    });
    sendToJavaMock.mockClear();

    act(() => {
      hook.result.current.loadServerTools(projectTwin, false);
    });

    expect(sendToJavaMock).toHaveBeenCalledWith('get_mcp_server_tools', {
      serverId: 'server-a',
      forceRefresh: false,
    });
    expect(hook.result.current.serverTools[projectKey]?.tools).toEqual([]);
    expect(hook.result.current.serverTools[projectKey]?.loading).toBe(true);
    hook.unmount();
  });

  it('restores the expanded card from a persisted card key', () => {
    writeCache(cacheKeys.SERVERS, [server, projectTwin]);
    localStorage.setItem(cacheKeys.LAST_SERVER_ID, projectKey);

    const hook = renderServerData();

    expect(Array.from(hook.result.current.expandedServers)).toEqual([projectKey]);
    hook.unmount();
  });

  it('accepts a persisted bare id written by an older build when it is unambiguous', () => {
    writeCache(cacheKeys.SERVERS, [server, otherServer]);
    localStorage.setItem(cacheKeys.LAST_SERVER_ID, otherServer.id);

    const hook = renderServerData();

    expect(Array.from(hook.result.current.expandedServers)).toEqual([getServerCardKey(otherServer)]);
    hook.unmount();
  });

  it('restores nothing when a persisted bare id names two cards', () => {
    writeCache(cacheKeys.SERVERS, [server, projectTwin]);
    localStorage.setItem(cacheKeys.LAST_SERVER_ID, 'server-a');

    const hook = renderServerData();

    // Guessing between the two records would open the wrong card, so nothing is restored.
    expect(hook.result.current.expandedServers.size).toBe(0);
    hook.unmount();
  });

  it('restores nothing when the persisted card key names no server', () => {
    writeCache(cacheKeys.SERVERS, [server]);
    localStorage.setItem(cacheKeys.LAST_SERVER_ID, 'removed-server::project');

    const hook = renderServerData();

    expect(hook.result.current.expandedServers.size).toBe(0);
    hook.unmount();
  });

  it('keeps a card key stable across status, approval and enablement changes', () => {
    const before = getServerCardKey({
      ...server,
      approvalStatus: 'pending',
      trustVerified: true,
      enabled: false,
      conflicting: false,
    });
    const after = getServerCardKey({ ...server, approvalStatus: 'approved', enabled: true });

    expect(before).toBe(after);
    // Only the on-disk config scope separates two cards.
    expect(getServerCardKey({ ...server, source: 'project' })).toBe('server-a::project');
    expect(getServerCardKey(projectTwin)).toBe('server-a::project');
  });
});

