import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../contexts/SessionContext';
import { useUIState } from '../contexts/UIStateContext';
import { sendBridgeEvent } from '../utils/bridge';
import { parseClaudeModelMappingEnv, setSessionClaudeModelMapping } from '../utils/claudeModelMapping';
import { setSessionClaudeModelCatalog, type SessionClaudeModelCatalog } from '../utils/sessionClaudeModelCatalog';

export interface SupplierEntry {
  id: string;
  name: string;
  available: boolean;
}

interface SupplierSnapshot {
  provider: string;
  requestId: string;
  sessionId?: string | null;
  bindingToken?: string;
  supplierId?: string;
  activeSupplierId?: string;
  busy?: boolean;
  suppliers?: SupplierEntry[];
  modelMappingEnv?: Record<string, string>;
  modelCatalog?: SessionClaudeModelCatalog;
  thinkingEnabled?: boolean;
  error?: string;
}

declare global {
  interface Window {
    onSessionSuppliers?: (payload: string) => void;
  }
}

export interface SessionThinkingSettings {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export interface SessionSupplierState {
  provider: string;
  suppliers: SupplierEntry[];
  supplierId?: string;
  bindingToken?: string;
  pending: boolean;
  busy: boolean;
  error: boolean;
  missing: boolean;
  deferred: boolean;
  refresh: () => void;
  selectSupplier: (supplierId: string) => Promise<boolean>;
  thinkingSettings: SessionThinkingSettings | null;
}

/** Backend owns the binding; menu choices never write a global supplier default. */
export function useSessionSuppliers(provider: string, busy: boolean): SessionSupplierState {
  const { currentSessionId } = useSession();
  const { currentView } = useUIState();
  const [snapshot, setSnapshot] = useState<SupplierSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const requestRef = useRef('');
  const completeRequest = useRef<((success: boolean) => void) | null>(null);
  const responseTimer = useRef<number | undefined>(undefined);
  const snapshotRef = useRef<SupplierSnapshot | null>(null);
  const pendingRef = useRef(false);
  const refreshAfterPending = useRef(false);
  const previousBusy = useRef(busy);
  const supported = provider === 'claude' || provider === 'codex';

  const finishRequest = useCallback((success: boolean) => {
    window.clearTimeout(responseTimer.current);
    pendingRef.current = false;
    setPending(false);
    completeRequest.current?.(success);
    completeRequest.current = null;
  }, []);

  const request = useCallback((supplierId?: string, thinkingEnabled?: boolean): Promise<boolean> => {
    if (!supported) return Promise.resolve(false);
    if (pendingRef.current) {
      if (supplierId === undefined && thinkingEnabled === undefined) refreshAfterPending.current = true;
      return Promise.resolve(false);
    }
    if (thinkingEnabled !== undefined) {
      if (!snapshotRef.current?.supplierId) return Promise.resolve(false);
      supplierId = snapshotRef.current.supplierId;
    }
    // A selection must use an acknowledged binding, including its epoch fence.
    if (supplierId !== undefined && (!snapshotRef.current?.bindingToken
      || !snapshotRef.current.suppliers?.some(entry => entry.id === supplierId && entry.available))) {
      return Promise.resolve(false);
    }
    const result = new Promise<boolean>(resolve => { completeRequest.current = resolve; });
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    window.clearTimeout(responseTimer.current);
    setPending(true);
    pendingRef.current = true;
    const sent = sendBridgeEvent(supplierId === undefined ? 'get_session_suppliers' : 'set_session_supplier', JSON.stringify({
      provider, requestId, supplierId, thinkingEnabled,
      ...(supplierId === undefined ? {} : { sessionId: snapshotRef.current?.sessionId ?? null, bindingToken: snapshotRef.current?.bindingToken }),
    }));
    if (sent === false) {
      finishRequest(false);
      setError(true);
    } else if (pendingRef.current) {
      responseTimer.current = window.setTimeout(() => {
        if (requestRef.current === requestId) {
          requestRef.current = '';
          finishRequest(false);
          setError(true);
        }
      }, 10000);
    }
    return result;
  }, [provider, supported, finishRequest]);

  useEffect(() => {
    if (!pending && refreshAfterPending.current) {
      refreshAfterPending.current = false;
      request();
    }
  }, [pending, request]);

  useEffect(() => {
    if (!supported) return;
    snapshotRef.current = null;
    setSnapshot(null);
    setPending(false);
    setError(false);
    const receive = (payload: string) => {
      let reply: SupplierSnapshot;
      try { reply = JSON.parse(payload) as SupplierSnapshot; } catch { return; }
      if (reply.provider !== provider || reply.requestId !== requestRef.current) return;
      setError(Boolean(reply.error));
      if (reply.error) {
        finishRequest(false);
        return;
      }
      setSnapshot(reply);
      snapshotRef.current = reply;
      finishRequest(true);
      window.dispatchEvent(new CustomEvent('session-supplier-snapshot', { detail: {
        provider: reply.provider, supplierId: reply.supplierId, bindingToken: reply.bindingToken, busy: reply.busy,
      } }));
      if (provider === 'claude') {
        setSessionClaudeModelMapping(parseClaudeModelMappingEnv(reply.modelMappingEnv));
        setSessionClaudeModelCatalog(reply.modelCatalog ?? { models: [], defaultModel: null, replaceBuiltInOptions: false });
      }
    };
    window.onSessionSuppliers = receive;
    let attempts = 0;
    const load = () => {
      if (window.sendToJava) {
        if (!pendingRef.current) request();
      }
      else if (++attempts < 20) timer = window.setTimeout(load, 100);
    };
    let timer = window.setTimeout(load, 0);
    const refresh = () => request();
    const resetBinding = () => {
      window.clearTimeout(timer);
      window.clearTimeout(responseTimer.current);
      requestRef.current = '';
      finishRequest(false);
      refreshAfterPending.current = false;
      snapshotRef.current = null;
      setSnapshot(null);
      setError(false);
      setSessionClaudeModelMapping(null);
      setSessionClaudeModelCatalog(null);
      request();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('session-suppliers-refresh', refresh);
    window.addEventListener('session-supplier-binding-changed', resetBinding);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(responseTimer.current);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('session-suppliers-refresh', refresh);
      window.removeEventListener('session-supplier-binding-changed', resetBinding);
      if (window.onSessionSuppliers === receive) delete window.onSessionSuppliers;
      requestRef.current = '';
      pendingRef.current = false;
      completeRequest.current?.(false);
      completeRequest.current = null;
      refreshAfterPending.current = false;
      setSessionClaudeModelMapping(null);
      setSessionClaudeModelCatalog(null);
    };
  }, [provider, currentSessionId, currentView, request, supported, finishRequest]);

  const thinkingSettings = useMemo<SessionThinkingSettings | null>(() => (
    provider === 'claude' && snapshot?.provider === provider && typeof snapshot.thinkingEnabled === 'boolean'
      ? { enabled: snapshot.thinkingEnabled, onChange: enabled => { void request(undefined, enabled); } } : null
  ), [provider, snapshot, request]);

  useEffect(() => {
    const changed = previousBusy.current !== busy;
    previousBusy.current = busy;
    if (changed && window.sendToJava) request();
  }, [busy, request]);

  const refresh = useCallback(() => { void request(); }, [request]);
  const selectSupplier = useCallback((supplierId: string) => request(supplierId), [request]);

  return useMemo(() => {
    const current = snapshot?.provider === provider ? snapshot : null;
    const suppliers = current?.suppliers ?? [];
    const supplierId = current?.supplierId;
    return {
      provider, suppliers, supplierId, bindingToken: current?.bindingToken, pending, error,
      busy: Boolean(busy || current?.busy),
      missing: !suppliers.some(entry => entry.id === supplierId && entry.available),
      deferred: Boolean((busy || current?.busy) && current?.activeSupplierId !== supplierId),
      refresh, selectSupplier, thinkingSettings,
    };
  }, [provider, snapshot, pending, error, busy, refresh, selectSupplier, thinkingSettings]);
}
