import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as bridge from '../utils/bridge';
import { subscribeActiveCodexProvider } from '../utils/runtimeProviderCapabilities';

export interface CodexNativeCatalogState {
  models: Record<string, unknown>[];
  skills: Record<string, unknown>[];
  mcpServers: Record<string, unknown>[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  reloadMcp: () => void;
  /**
   * Synchronous in-flight check. `loading` lags one commit behind `refresh()`,
   * so same-commit consumers (effect ordering) must read this instead.
   */
  hasPendingRequests: () => boolean;
}

interface NativeDataEnvelope {
  requestType?: string;
  data?: unknown;
  error?: string;
  requestId?: string;
  cwd?: string;
  nextCursor?: unknown;
}

function sendNativeBridge(event: string, payload: string): boolean {
  const availableExports = Object.keys(bridge);
  if (availableExports.includes('sendBridgeEvent')) {
    return bridge.sendBridgeEvent(event, payload) !== false;
  }
  if (availableExports.includes('sendToJava')) {
    bridge.sendToJava(event, payload);
    return true;
  }
  if (typeof window.sendToJava === 'function') {
    window.sendToJava(`${event}:${payload}`);
    return true;
  }
  return false;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

/** Reads model/skill/MCP catalogs through the authorized app-server channel. */
export function useCodexNativeCatalog(
  provider: string,
  cwd = '',
  enabled = true,
  catalog: 'all' | 'skills' | 'mcp' = 'all',
): CodexNativeCatalogState {
  const [models, setModels] = useState<Record<string, unknown>[]>([]);
  const [skills, setSkills] = useState<Record<string, unknown>[]>([]);
  const [mcpServers, setMcpServers] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(new Map<string, { requestId: string; rows: Record<string, unknown>[]; cursors: Set<unknown> }>());
  const requestCatalog = useCallback((type: string) => {
    const requestId = `catalog-${crypto.randomUUID()}`;
    pendingRef.current.set(type, { requestId, rows: [], cursors: new Set() });
    if (!sendNativeBridge(type, JSON.stringify({ ...(cwd ? { cwd } : {}), requestId,
      ...(type === 'codex_native_list_skills' ? { params: { forceReload: true } } : {}) }))) {
      pendingRef.current.delete(type);
      setLoading(pendingRef.current.size > 0);
      setError('Native Codex bridge is unavailable');
    }
  }, [cwd]);

  const refresh = useCallback(() => {
    if (provider !== 'codex' || !enabled) return;
    setLoading(true);
    setError(null);
    setModels((previous) => previous.length ? [] : previous);
    setSkills((previous) => previous.length ? [] : previous);
    setMcpServers((previous) => previous.length ? [] : previous);
    pendingRef.current.clear();
    if (catalog === 'all') requestCatalog('codex_native_list_models');
    if (catalog !== 'mcp') requestCatalog('codex_native_list_skills');
    if (catalog !== 'skills') requestCatalog('codex_native_mcp_status');
  }, [catalog, enabled, provider, requestCatalog]);

  const reloadMcp = useCallback(() => {
    if (provider !== 'codex' || !enabled) return;
    setLoading(true);
    requestCatalog('codex_native_mcp_reload');
  }, [enabled, provider, requestCatalog]);

  useEffect(() => {
    setModels((previous) => previous.length ? [] : previous);
    setSkills((previous) => previous.length ? [] : previous);
    setMcpServers((previous) => previous.length ? [] : previous);
    setLoading(false);
    if (provider !== 'codex' || !enabled) return;
    let live = true;
    const onData = (event: Event) => {
      const envelope = (event as CustomEvent<NativeDataEnvelope>).detail;
      if (!envelope?.requestType) return;
      const pending = pendingRef.current.get(envelope.requestType);
      if (!pending || pending.requestId !== envelope.requestId
          || (cwd && envelope.cwd && cwd !== envelope.cwd)) return;
      if (envelope.error) setError(envelope.error);
      const rows = records(envelope.data);
      if (envelope.requestType === 'codex_native_list_skills') {
        const errors = rows.flatMap((row) => records(row.errors)).map((entry) => entry.message).filter(Boolean);
        if (errors.length) setError(errors.join('\n'));
      }
      pending.rows.push(...(envelope.requestType === 'codex_native_list_skills'
        ? rows.flatMap((entry) => Array.isArray(entry.skills) ? records(entry.skills) : [entry]) : rows));
      if (!envelope.error && envelope.nextCursor != null) {
        if (pending.cursors.has(envelope.nextCursor)) {
          setError('Native catalog repeated its pagination cursor');
        } else if (pending.cursors.size >= 100) {
          setError('Native catalog exceeded its pagination limit');
        } else {
          pending.cursors.add(envelope.nextCursor);
          if (sendNativeBridge(envelope.requestType, JSON.stringify({ ...(cwd ? { cwd } : {}),
            requestId: pending.requestId, params: { cursor: envelope.nextCursor } }))) return;
          setError('Native Codex bridge is unavailable');
        }
      }
      pendingRef.current.delete(envelope.requestType);
      if (envelope.requestType === 'codex_native_list_models') setModels(pending.rows);
      if (envelope.requestType === 'codex_native_list_skills') setSkills(pending.rows);
      if (envelope.requestType === 'codex_native_mcp_status') setMcpServers(pending.rows);
      setLoading(pendingRef.current.size > 0);
      if (envelope.requestType === 'codex_native_mcp_reload' && !envelope.error) refresh();
    };
    let refreshScheduled = false;
    let effectiveCwd: string | undefined;
    const scheduleRefresh = () => {
      if (refreshScheduled) return;
      refreshScheduled = true;
      queueMicrotask(() => { refreshScheduled = false; if (live) refresh(); });
    };
    const onRuntime = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; threadId?: string; rootThreadId?: string;
        payload?: { method?: string; cwd?: string; settings?: { cwd?: string } } }>).detail;
      if (detail?.payload?.method === 'skills/changed' && catalog !== 'mcp') scheduleRefresh();
      if (detail?.threadId && detail.threadId === detail.rootThreadId) {
        const nextCwd = detail.payload?.settings?.cwd ?? detail.payload?.cwd;
        if (nextCwd && nextCwd !== effectiveCwd) {
          effectiveCwd = nextCwd;
          scheduleRefresh();
        }
      }
    };
    window.addEventListener('codex-native-data', onData);
    window.addEventListener('codex-runtime-event', onRuntime);
    window.addEventListener('codex-working-directory-changed', scheduleRefresh);
    const unsubscribeProvider = subscribeActiveCodexProvider(refresh);
    refresh();
    return () => {
      live = false;
      pendingRef.current.clear();
      unsubscribeProvider();
      window.removeEventListener('codex-native-data', onData);
      window.removeEventListener('codex-runtime-event', onRuntime);
      window.removeEventListener('codex-working-directory-changed', scheduleRefresh);
    };
  }, [cwd, enabled, provider, refresh]);

  const hasPendingRequests = useCallback(() => pendingRef.current.size > 0, []);

  return useMemo(() => ({ models, skills, mcpServers, loading, error, refresh, reloadMcp, hasPendingRequests }), [
    error, loading, mcpServers, models, refresh, reloadMcp, skills, hasPendingRequests,
  ]);
}

