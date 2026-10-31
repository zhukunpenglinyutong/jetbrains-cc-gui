import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '../types';
import type { CacheKeys } from '../types';
import { readToolsCache, writeCache, writeToolsCache } from '../utils';
import { useServerData } from './useServerData';

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
  delete window.updateCodexMcpServers;
  delete window.updateCodexMcpServerStatus;
});

describe('useServerData terminal MCP status handling', () => {
  it('clears runtime and persisted tools when a matching server fails', () => {
    const hook = renderServerData();

    act(() => {
      window.updateMcpServers?.(JSON.stringify([server]));
      hook.result.current.setServerTools({
        [server.id]: { tools: [{ name: 'stale-tool' }], loading: false },
      });
      writeToolsCache(server.id, [{ name: 'stale-tool' }], cacheKeys);
    });

    act(() => {
      window.updateMcpServerStatus?.(JSON.stringify([{
        name: server.name,
        status: 'failed',
      }]));
    });

    expect(hook.result.current.serverTools[server.id]).toBeUndefined();
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

    expect(hook.result.current.serverTools[server.id]).toBeUndefined();
    expect(readToolsCache(server.id, cacheKeys)).toBeNull();
    hook.unmount();
  });
});

describe.each([false, true])('refreshing expanded tools (Codex=%s)', isCodexMode => {
  function renderProvider() {
    return renderHook(() => useServerData({
      isCodexMode, messagePrefix: isCodexMode ? 'codex_' : '', cacheKeys, t: translate, onLog,
    }));
  }
  function deliver(servers: McpServer[]) {
    const callback = isCodexMode ? window.updateCodexMcpServers : window.updateMcpServers;
    act(() => callback?.(JSON.stringify(servers)));
  }

  it('uses the new catalog and fetches only the expanded card once', () => {
    const hook = renderProvider();
    deliver([server, { ...server, id: 'closed' }]);
    act(() => hook.result.current.setExpandedServers(new Set([server.id])));
    sendToJavaMock.mockClear();
    act(() => hook.result.current.loadServers(true));
    const toolsAction = isCodexMode ? 'get_codex_mcp_server_tools' : 'get_mcp_server_tools';
    expect(sendToJavaMock).not.toHaveBeenCalledWith(toolsAction, expect.anything());
    deliver([{ ...server, name: 'Updated configuration' }, { ...server, id: 'newly-added' }]);
    expect(sendToJavaMock.mock.calls.filter(([action]) => action === toolsAction)).toEqual([
      [toolsAction, { serverId: server.id, forceRefresh: true }],
    ]);
    expect(onLog).toHaveBeenCalledWith(expect.any(String), 'info', undefined,
      'Updated configuration', expect.any(String));
    deliver([server]);
    expect(sendToJavaMock.mock.calls.filter(([action]) => action === toolsAction)).toHaveLength(1);
    hook.unmount();
  });

  it('keeps a pending refresh when a plain catalog load follows it', () => {
    const hook = renderProvider();
    deliver([server]);
    act(() => hook.result.current.setExpandedServers(new Set([server.id])));
    sendToJavaMock.mockClear();
    act(() => hook.result.current.loadServers(true));
    act(() => hook.result.current.loadServers());
    deliver([server]);
    const toolsAction = isCodexMode ? 'get_codex_mcp_server_tools' : 'get_mcp_server_tools';
    expect(sendToJavaMock.mock.calls.filter(([action]) => action === toolsAction)).toEqual([
      [toolsAction, { serverId: server.id, forceRefresh: true }],
    ]);
    hook.unmount();
  });

  it.each(['deleted', 'disabled'])('does not query an expanded server that is now %s', state => {
    const hook = renderProvider();
    deliver([server]);
    act(() => hook.result.current.setExpandedServers(new Set([server.id])));
    act(() => hook.result.current.loadServers(true));
    sendToJavaMock.mockClear();
    deliver(state === 'deleted' ? [] : [{ ...server, enabled: false, apps: { claude: false, codex: false, gemini: false } }]);
    expect(sendToJavaMock).not.toHaveBeenCalled();
    hook.unmount();
  });
});
