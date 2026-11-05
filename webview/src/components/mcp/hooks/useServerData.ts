/**
 * Server Data Loading and Initialization Hook
 * Manages loading of server list, status, and cache
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { McpServer, McpServerStatusInfo, ServerToolsState, RefreshLog, CacheKeys } from '../types';
import { sendToJava } from '../../../utils/bridge';
import { clearToolsCache, readCache, readToolsCache, writeCache } from '../utils';
import {
  applyServerToolsUpdate,
  buildServerCardIndex,
  EMPTY_SERVER_CARD_INDEX,
  getServerCardKey,
  resolvePersistedCardKey,
  type ServerCardIndex,
} from '../serverCardKey';

const TERMINAL_DISCONNECT_STATUSES = new Set<McpServerStatusInfo['status']>([
  'failed',
  'needs-auth',
  'disabled',
]);

function normalizeServerKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function getTerminalStatusNames(statusList: McpServerStatusInfo[]): Set<string> {
  return new Set(
    statusList.flatMap((status) => {
      if (!TERMINAL_DISCONNECT_STATUSES.has(status.status)) return [];
      const name = normalizeServerKey(status.name);
      return name ? [name] : [];
    }),
  );
}

function getTerminalServerIds(servers: McpServer[], terminalStatusNames: Set<string>): string[] {
  if (terminalStatusNames.size === 0) {
    return [];
  }

  return servers.flatMap((server) => {
    if (terminalStatusNames.has(normalizeServerKey(server.id))
      || terminalStatusNames.has(normalizeServerKey(server.name))) {
      return [server.id];
    }
    return [];
  });
}

/** Every name a status entry for this server could be keyed by. */
function getKnownStatusKeys(servers: McpServer[]): Set<string> {
  const keys = new Set<string>();
  servers.forEach((server) => {
    const id = normalizeServerKey(server.id);
    if (id) keys.add(id);
    const name = normalizeServerKey(server.name);
    if (name) keys.add(name);
  });
  return keys;
}

/**
 * Copy of the server list without its secrets, for persistence.
 * env/headers hold API keys and the backend forwards them verbatim from
 * ~/.claude.json / .mcp.json; caching them in localStorage would keep them readable
 * on disk for the whole cache lifetime. The live state keeps the full spec — only
 * the cached copy is trimmed.
 */
function toCacheableServers(servers: McpServer[]): McpServer[] {
  return servers.map((server) => {
    const spec = server.server;
    if (!spec || spec.env === undefined && spec.headers === undefined) {
      return server;
    }
    const { env, headers, ...restSpec } = spec;
    return { ...server, server: restSpec };
  });
}

export interface UseServerDataOptions {
  isCodexMode: boolean;
  messagePrefix: string;
  cacheKeys: CacheKeys;
  t: (key: string, options?: Record<string, unknown>) => string;
  onLog: (message: string, type: RefreshLog['type'], details?: string, serverName?: string, requestInfo?: string, errorReason?: string) => void;
}

export interface UseServerDataReturn {
  // State
  servers: McpServer[];
  serverStatus: Map<string, McpServerStatusInfo>;
  loading: boolean;
  statusLoading: boolean;
  /** Keyed by server card key (`getServerCardKey`), never by server id. */
  serverTools: ServerToolsState;
  /** Server card keys (`getServerCardKey`), never server ids. */
  expandedServers: Set<string>;

  // State update functions
  setServers: React.Dispatch<React.SetStateAction<McpServer[]>>;
  setServerStatus: React.Dispatch<React.SetStateAction<Map<string, McpServerStatusInfo>>>;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  setExpandedServers: React.Dispatch<React.SetStateAction<Set<string>>>;

  // Data loading functions
  loadServers: () => void;
  loadServerStatus: (serverNames?: string[]) => void;
  loadServerTools: (server: McpServer, forceRefresh?: boolean) => void;
}

/**
 * Server Data Loading and Initialization Hook
 */
export function useServerData({
  isCodexMode,
  messagePrefix,
  cacheKeys,
  t,
  onLog
}: UseServerDataOptions): UseServerDataReturn {
  // State
  const [servers, setServersState] = useState<McpServer[]>([]);
  const [serverStatus, setServerStatus] = useState<Map<string, McpServerStatusInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [serverTools, setServerToolsState] = useState<ServerToolsState>({});
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  // Refs
  const refreshTimersRef = useRef<number[]>([]);
  const serversRef = useRef<McpServer[]>([]);
  const terminalStatusNamesRef = useRef<Set<string>>(new Set());
  // Card keys of the current list, and the cards waiting for a tools response, keyed by
  // the server id the bridge will report that response under. See ../serverCardKey.
  const cardIndexRef = useRef<ServerCardIndex>(EMPTY_SERVER_CARD_INDEX);
  const pendingToolsCardsRef = useRef<Map<string, string[]>>(new Map());
  const serverToolsRef = useRef<ServerToolsState>({});

  const setServers = useCallback((value: React.SetStateAction<McpServer[]>) => {
    // serversRef always holds the latest list, so functional updates can be
    // resolved synchronously here instead of inside the state updater.
    const next = typeof value === 'function' ? value(serversRef.current) : value;
    serversRef.current = next;

    const index = buildServerCardIndex(next);
    cardIndexRef.current = index;
    // A card that left the list can never answer the request it made; drop the wait so a
    // later response for that id is not handed to whatever card is queued behind it.
    pendingToolsCardsRef.current.forEach((cardKeys, serverId) => {
      const live = cardKeys.filter((cardKey) => index.cardKeys.has(cardKey));
      if (live.length === 0) {
        pendingToolsCardsRef.current.delete(serverId);
      } else if (live.length !== cardKeys.length) {
        pendingToolsCardsRef.current.set(serverId, live);
      }
    });

    setServersState(next);
  }, []);

  /** Queue the card that asked for a tools list, so the response can be told apart. */
  const expectToolsFor = useCallback((serverId: string, cardKey: string) => {
    const pending = pendingToolsCardsRef.current.get(serverId) ?? [];
    pendingToolsCardsRef.current.set(serverId, [...pending.filter((key) => key !== cardKey), cardKey]);
  }, []);

  /**
   * Hand back the card that is waiting for the next response for this server id.
   *
   * The bridge identifies a tools response by server id alone, so with two colliding
   * cards that id names both. Requests are queued in the order they were made, which is
   * also the order the user expanded the cards in.
   */
  const claimToolsCard = useCallback((serverId: string): string | null => {
    const pending = pendingToolsCardsRef.current.get(serverId);
    if (!pending || pending.length === 0) return null;
    const cardKey = pending.shift() as string;
    if (pending.length === 0) {
      pendingToolsCardsRef.current.delete(serverId);
    }
    return cardKey;
  }, []);

  /**
   * `setServerTools` for the rest of the section.
   *
   * Everything the UI stores per card is keyed by card key, but the bridge callbacks that
   * write this state only carry the backend server id. Translating here keeps a single
   * key scheme in the state itself instead of asking every writer to know about both.
   *
   * Like `setServers`, the update is resolved against a ref rather than inside the state
   * updater: matching an incoming update to the card that asked for it is a bookkeeping
   * side effect (it consumes a pending request) and must happen exactly once.
   */
  const setServerTools = useCallback((value: React.SetStateAction<ServerToolsState>) => {
    // A wholesale replacement ("refresh all" clears the map) leaves no card to answer an
    // in-flight response, so the queue goes with it.
    if (typeof value !== 'function' && !Object.keys(value).some((key) => cardIndexRef.current.cardKeys.has(key))) {
      pendingToolsCardsRef.current.clear();
    }
    const next = applyServerToolsUpdate(serverToolsRef.current, value, cardIndexRef.current, claimToolsCard);
    serverToolsRef.current = next;
    setServerToolsState(next);
  }, [claimToolsCard]);

  const clearToolsForTerminalStatuses = useCallback((
    currentServers: McpServer[],
    terminalStatusNames: Set<string>,
  ) => {
    const terminalServerIds = getTerminalServerIds(currentServers, terminalStatusNames);
    if (terminalServerIds.length === 0) {
      return;
    }

    terminalServerIds.forEach((serverId) => clearToolsCache(serverId, cacheKeys));
    // Deleted by server id on purpose: setServerTools turns that into the card key(s) of
    // every card carrying the id, and the persisted cache is keyed by the same id.
    setServerTools((previous) => {
      const next = { ...previous };
      terminalServerIds.forEach((serverId) => {
        delete next[serverId];
      });
      return next;
    });
  }, [cacheKeys, setServerTools]);

  // Load server list
  const loadServers = useCallback(() => {
    setLoading(true);
    onLog(
      t('mcp.logs.loadingServers'),
      'info',
      undefined,
      undefined,
      `get_${messagePrefix}mcp_servers request to backend`
    );
    sendToJava(`get_${messagePrefix}mcp_servers`, {});
  }, [messagePrefix, t, onLog]);

  // Load server status
  // Passing serverNames restricts the check to those servers: verifying a server spawns a
  // process (stdio) or issues a request (http/sse), so a full check disturbs every server.
  const loadServerStatus = useCallback((serverNames?: string[]) => {
    const isPartial = Array.isArray(serverNames) && serverNames.length > 0;
    // A targeted refresh runs in the background — no section-wide spinner.
    if (!isPartial) {
      setStatusLoading(true);
    }
    onLog(
      t('mcp.logs.refreshingStatus'),
      'info',
      undefined,
      undefined,
      `get_${messagePrefix}mcp_server_status request to backend`
        + (isPartial ? ` (only: ${serverNames.join(', ')})` : ''),
      `Querying MCP server connection status via ${isCodexMode ? 'Codex' : 'Claude'} SDK`
    );
    sendToJava(
      `get_${messagePrefix}mcp_server_status`,
      isPartial ? { serverNames } : {}
    );
  }, [messagePrefix, isCodexMode, t, onLog]);

  // Load server tools list
  const loadServerTools = useCallback((server: McpServer, forceRefresh = false) => {
    const cardKey = getServerCardKey(server);
    // The persisted tools cache is keyed by the backend server id (only the bridge
    // callbacks write it), so it cannot tell two colliding cards apart. Reading it would
    // hand one card the other card's tools; ask the backend instead.
    const cacheIsShared = !cardIndexRef.current.hasUniqueServerId(server.id);

    // Check cache (unless force refresh)
    if (!forceRefresh && !cacheIsShared) {
      const cachedTools = readToolsCache(server.id, cacheKeys);
      if (cachedTools && cachedTools.length > 0) {
        setServerTools(prev => ({
          ...prev,
          [cardKey]: {
            tools: cachedTools,
            loading: false,
            error: undefined
          }
        }));
        onLog(
          t('mcp.logs.loadedToolsFromCache', { name: server.name || server.id, count: cachedTools.length }),
          'info',
          undefined,
          server.name || server.id
        );
        return;
      }
    }

    // Set loading state
    setServerTools(prev => ({
      ...prev,
      [cardKey]: {
        tools: [],
        loading: true,
        error: undefined
      }
    }));

    onLog(
      forceRefresh
        ? t('mcp.logs.forceRefreshingTools', { name: server.name || server.id })
        : t('mcp.logs.loadingTools', { name: server.name || server.id }),
      'info',
      undefined,
      server.name || server.id,
      `get_${messagePrefix}mcp_server_tools request to backend`
    );

    // The request is made on behalf of this card: remember which one, so the response —
    // which names only the server id — lands on the right card.
    expectToolsFor(server.id, cardKey);
    sendToJava(`get_${messagePrefix}mcp_server_tools`, { serverId: server.id, forceRefresh });
  }, [cacheKeys, messagePrefix, t, onLog, setServerTools, expectToolsFor]);

  // Initialization and data loading
  useEffect(() => {
    const clearRefreshTimers = () => {
      refreshTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      refreshTimersRef.current = [];
    };

    // Load data from cache
    const loadFromCache = (): boolean => {
      terminalStatusNamesRef.current = new Set();
      const cachedServers = readCache<McpServer[]>(cacheKeys.SERVERS, cacheKeys);
      const hasValidCache = !!cachedServers && cachedServers.length > 0;

      if (hasValidCache) {
        setServers(cachedServers);
        setLoading(false);
        let cachedAt = 0;
        try {
          const parsed: unknown = JSON.parse(localStorage.getItem(cacheKeys.SERVERS) || '{}');
          if (parsed && typeof parsed === 'object' && 'timestamp' in parsed && typeof parsed.timestamp === 'number') {
            cachedAt = parsed.timestamp;
          }
        } catch {
          // Malformed cache payload — treat as cache with no timestamp.
        }
        const cacheAge = Date.now() - cachedAt;
        if (cacheAge < 60000) {
          onLog(t('mcp.logs.fastLoadCache', { count: cachedServers.length, seconds: Math.round(cacheAge/1000) }), 'info');
        }
      }

      if (!isCodexMode) {
        const cachedStatus = readCache<McpServerStatusInfo[]>(cacheKeys.STATUS, cacheKeys);
        if (cachedStatus && cachedStatus.length > 0) {
          const terminalStatusNames = getTerminalStatusNames(cachedStatus);
          terminalStatusNamesRef.current = terminalStatusNames;
          clearToolsForTerminalStatuses(cachedServers || [], terminalStatusNames);
          const statusMap = new Map<string, McpServerStatusInfo>();
          cachedStatus.forEach((status) => {
            statusMap.set(status.name, status);
          });
          setServerStatus(statusMap);
          setStatusLoading(false);
        }
      }

      // Restore last expanded server
      if (hasValidCache) {
        try {
          // The persisted value is a card key. A value written before card keys existed
          // is a bare server id and is only honoured when exactly one card carries that
          // id; anything ambiguous resolves to null and simply restores nothing.
          const cardKey = resolvePersistedCardKey(localStorage.getItem(cacheKeys.LAST_SERVER_ID), cardIndexRef.current);
          if (cardKey) {
            const restored = cardIndexRef.current.findServer(cardKey);
            setExpandedServers(new Set([cardKey]));
            // Same rule as loadServerTools: the persisted tools cache is keyed by server
            // id, so with two cards sharing it its contents are not this card's.
            const cachedTools = restored && cardIndexRef.current.hasUniqueServerId(restored.id)
              ? readToolsCache(restored.id, cacheKeys)
              : null;
            if (cachedTools && cachedTools.length > 0) {
              setServerTools(prev => ({
                ...prev,
                [cardKey]: {
                  tools: cachedTools,
                  loading: false,
                  error: undefined
                }
              }));
              onLog(
                t('mcp.logs.loadedToolsFromCacheSimple', { count: cachedTools.length }),
                'info',
                undefined,
                restored?.id
              );
            }
          }
        } catch (e) {
          console.warn('[MCP] Failed to restore last expanded server:', e);
        }
      }

      return hasValidCache;
    };

    // Try loading data from cache first
    const hasCache = loadFromCache();

    if (hasCache) {
      onLog(t('mcp.logs.usingCacheStrategy'), 'info');
      // The cached copy is metadata-only (see toCacheableServers), so re-read the
      // list from the backend in the background instead of making the user wait for
      // it: editing a server must still see its env block. Cheap — it just re-parses
      // the config files — and it does not re-run the status check, which would spawn
      // every server's process.
      loadServers();
    } else {
      onLog(t('mcp.logs.firstLoad'), 'info');
      loadServers();
      loadServerStatus();
    }

    return () => {
      clearRefreshTimers();
    };
  }, [cacheKeys, isCodexMode, loadServers, loadServerStatus, t, onLog, clearToolsForTerminalStatuses, setServerTools]);

  // Register server list update callback
  useEffect(() => {
    const handleServerListUpdate = (jsonStr: string) => {
      try {
        const serverList: McpServer[] = JSON.parse(jsonStr);
        setServers(serverList);
        clearToolsForTerminalStatuses(serverList, terminalStatusNamesRef.current);
        setLoading(false);
        // Persist to cache so subsequent mounts can load instantly.
        // Secrets (env/headers) are stripped — the live state still holds them.
        writeCache(cacheKeys.SERVERS, toCacheableServers(serverList));
        onLog(t('mcp.logs.loadedServersSuccess', { count: serverList.length }), 'success');
      } catch (error) {
        console.error('[McpSettings] Failed to parse servers:', error);
        setLoading(false);
        onLog(t('mcp.logs.loadedServersFailed', { error: String(error) }), 'error');
      }
    };

    const handleServerStatusUpdate = (jsonStr: string) => {
      try {
        const statusList: McpServerStatusInfo[] = JSON.parse(jsonStr);
        const statusMap = new Map<string, McpServerStatusInfo>();
        statusList.forEach((status) => {
          statusMap.set(status.name, status);
        });
        setServerStatus(statusMap);
        const terminalStatusNames = getTerminalStatusNames(statusList);
        terminalStatusNamesRef.current = terminalStatusNames;
        clearToolsForTerminalStatuses(serversRef.current, terminalStatusNames);
        setStatusLoading(false);
        // Persist status to cache
        writeCache(cacheKeys.STATUS, statusList);

        const statusCount = {
          connected: statusList.filter(s => s.status === 'connected').length,
          failed: statusList.filter(s => s.status === 'failed').length,
          pending: statusList.filter(s => s.status === 'pending').length,
          needsAuth: statusList.filter(s => s.status === 'needs-auth').length
        };

        onLog(
          t('mcp.logs.statusUpdateComplete', {
            total: statusList.length,
            connected: statusCount.connected,
            failed: statusCount.failed,
            pending: statusCount.pending,
            needsAuth: statusCount.needsAuth
          }),
          statusCount.failed > 0 ? 'warning' : 'success'
        );
      } catch (error) {
        console.error('[McpSettings] Failed to parse server status:', error);
        setStatusLoading(false);
        onLog(t('mcp.logs.loadedStatusFailed', { error: String(error) }), 'error');
      }
    };

    /**
     * Targeted status update. The backend calls this instead of updateMcpServerStatus when the
     * request carried a serverNames filter (approve/reject only ever touches one server).
     * The payload is merged into the existing map and cache — replacing it would wipe the
     * statuses of every server that was not part of the request.
     */
    const handleServerStatusPartialUpdate = (jsonStr: string, requestedNamesJson?: string) => {
      try {
        const partial: McpServerStatusInfo[] = JSON.parse(jsonStr);
        const returned = new Set(partial.map((status) => status.name));

        // A rejected project .mcp.json server is removed from the config entirely, so a
        // targeted query returns nothing for it. Treat the response as authoritative for
        // the requested names: drop the ones that came back absent, or the card would keep
        // showing the pre-reject "connected" status until a full refresh replaced the map.
        let requested: string[] = [];
        if (requestedNamesJson) {
          try {
            const parsed = JSON.parse(requestedNamesJson);
            if (Array.isArray(parsed)) {
              requested = parsed.filter((name): name is string => typeof name === 'string');
            }
          } catch {
            // No usable name list — fall back to a pure merge.
          }
        }
        // This callback is reachable by any script running in the view's context, so
        // the names it names are not implicitly trusted: only entries that match a
        // server we actually know about may be removed from the map and the cache.
        const knownKeys = getKnownStatusKeys(serversRef.current);
        const dropped = requested.filter((name) => !returned.has(name)
          && knownKeys.has(normalizeServerKey(name)));
        if (dropped.length > 0) {
          console.warn('[MCP] Dropping stale status for removed server(s):', dropped.join(', '));
        }

        if (dropped.length > 0 || partial.length > 0) {
          setServerStatus(prev => {
            const next = new Map(prev);
            partial.forEach((status) => next.set(status.name, status));
            dropped.forEach((name) => next.delete(name));
            return next;
          });

          const cached = readCache<McpServerStatusInfo[]>(cacheKeys.STATUS, cacheKeys) || [];
          const byName = new Map(cached.map((status) => [status.name, status]));
          partial.forEach((status) => byName.set(status.name, status));
          dropped.forEach((name) => byName.delete(name));
          writeCache(cacheKeys.STATUS, Array.from(byName.values()));
        }

        // Union rather than replace: this ref drives tool cleanup in handleServerListUpdate,
        // so dropping the other servers' terminal names would leave stale tool lists behind.
        const partialTerminal = getTerminalStatusNames(partial);
        terminalStatusNamesRef.current = new Set([
          ...terminalStatusNamesRef.current,
          ...partialTerminal,
        ]);
        clearToolsForTerminalStatuses(serversRef.current, partialTerminal);

        onLog(
          t('mcp.logs.statusUpdateComplete', {
            total: partial.length,
            connected: partial.filter((s) => s.status === 'connected').length,
            failed: partial.filter((s) => s.status === 'failed').length,
            pending: partial.filter((s) => s.status === 'pending').length,
            needsAuth: partial.filter((s) => s.status === 'needs-auth').length,
          }),
          partial.some((s) => s.status === 'failed') ? 'warning' : 'success'
        );
        // statusLoading is intentionally untouched: a partial request never raised it.
      } catch (error) {
        console.error('[McpSettings] Failed to parse partial server status:', error);
        onLog(t('mcp.logs.loadedStatusFailed', { error: String(error) }), 'error');
      }
    };

    // Register callbacks
    if (isCodexMode) {
      window.updateCodexMcpServers = handleServerListUpdate;
      window.updateCodexMcpServerStatus = handleServerStatusUpdate;
    } else {
      window.updateMcpServers = handleServerListUpdate;
      window.updateMcpServerStatus = handleServerStatusUpdate;
      // Approve/reject is Claude-only (.mcp.json project trust), so the targeted
      // status callback has no Codex counterpart.
      window.updateMcpServerStatusPartial = handleServerStatusPartialUpdate;
    }

    // Triggered by the backend file watcher when .mcp.json / mcp.json changes
    const handleRefreshMcpServers = () => {
      onLog(t('mcp.logs.refreshOnFileChange'), 'info');
      loadServers();
      if (!isCodexMode) {
        loadServerStatus();
      }
    };
    window.refreshMcpServers = handleRefreshMcpServers;

    return () => {
      if (isCodexMode) {
        window.updateCodexMcpServers = undefined;
        window.updateCodexMcpServerStatus = undefined;
      } else {
        window.updateMcpServers = undefined;
        window.updateMcpServerStatus = undefined;
        window.updateMcpServerStatusPartial = undefined;
      }
      window.refreshMcpServers = undefined;
    };
  }, [isCodexMode, t, onLog, cacheKeys, clearToolsForTerminalStatuses, setServers, loadServers, loadServerStatus]);

  return {
    // State
    servers,
    serverStatus,
    loading,
    statusLoading,
    serverTools,
    expandedServers,

    // State update functions
    setServers,
    setServerStatus,
    setServerTools,
    setExpandedServers,

    // Data loading functions
    loadServers,
    loadServerStatus,
    loadServerTools,
  };
}
