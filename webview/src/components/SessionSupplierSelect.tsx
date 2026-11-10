import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../contexts/SessionContext';
import { useUIState } from '../contexts/UIStateContext';
import { sendBridgeEvent } from '../utils/bridge';
import { parseClaudeModelMappingEnv, setSessionClaudeModelMapping } from '../utils/claudeModelMapping';
import { setSessionClaudeModelCatalog, type SessionClaudeModelCatalog } from '../utils/sessionClaudeModelCatalog';
import './SessionSupplierSelect.css';

interface SupplierEntry {
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

interface SessionSupplierSelectProps {
  provider: string;
  busy: boolean;
  onThinkingSettingsChange?: (settings: SessionThinkingSettings | null) => void;
}

export interface SessionThinkingSettings {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

/** Backend owns the binding; the control never writes a global supplier default. */
export function SessionSupplierSelect({ provider, busy, onThinkingSettingsChange }: SessionSupplierSelectProps) {
  const { t } = useTranslation();
  const { currentSessionId } = useSession();
  const { currentView } = useUIState();
  const [snapshot, setSnapshot] = useState<SupplierSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const requestRef = useRef('');
  const responseTimer = useRef<number | undefined>(undefined);
  const snapshotRef = useRef<SupplierSnapshot | null>(null);
  const pendingRef = useRef(false);
  const refreshAfterPending = useRef(false);
  const previousBusy = useRef(busy);
  const supported = provider === 'claude' || provider === 'codex';

  const request = useCallback((supplierId?: string, thinkingEnabled?: boolean) => {
    if (!supported) return;
    if (pendingRef.current) {
      if (supplierId === undefined && thinkingEnabled === undefined) refreshAfterPending.current = true;
      return;
    }
    if (thinkingEnabled !== undefined) {
      if (pendingRef.current || !snapshotRef.current?.supplierId) return;
      supplierId = snapshotRef.current.supplierId;
    }
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
      setPending(false);
      pendingRef.current = false;
      setError(true);
    } else {
      responseTimer.current = window.setTimeout(() => {
        if (requestRef.current === requestId) {
          setPending(false);
          pendingRef.current = false;
          setError(true);
        }
      }, 10000);
    }
  }, [provider, supported]);

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
    const receive = (payload: string) => {
      let reply: SupplierSnapshot;
      try { reply = JSON.parse(payload) as SupplierSnapshot; } catch { return; }
      if (reply.provider !== provider || reply.requestId !== requestRef.current) return;
      window.clearTimeout(responseTimer.current);
      setPending(false);
      pendingRef.current = false;
      setError(Boolean(reply.error));
      if (reply.error) return;
      setSnapshot(reply);
      snapshotRef.current = reply;
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
      pendingRef.current = false;
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
      refreshAfterPending.current = false;
      setSessionClaudeModelMapping(null);
      setSessionClaudeModelCatalog(null);
    };
  }, [provider, currentSessionId, currentView, request, supported]);

  useEffect(() => {
    onThinkingSettingsChange?.(provider === 'claude' && snapshot?.provider === provider && typeof snapshot.thinkingEnabled === 'boolean'
      ? { enabled: snapshot.thinkingEnabled, onChange: enabled => request(undefined, enabled) } : null);
    return () => onThinkingSettingsChange?.(null);
  }, [provider, snapshot, request, onThinkingSettingsChange]);

  useEffect(() => {
    const changed = previousBusy.current !== busy;
    previousBusy.current = busy;
    if (changed && window.sendToJava) request();
  }, [busy, request]);

  if (!supported) return null;
  const suppliers = snapshot?.provider === provider ? snapshot.suppliers ?? [] : [];
  const selectedId = snapshot?.provider === provider ? snapshot.supplierId : undefined;
  const missing = !suppliers.some(entry => entry.id === selectedId && entry.available);
  const deferred = (busy || snapshot?.busy) && snapshot?.activeSupplierId !== selectedId;

  return (
    <div className="session-supplier-row">
      <label className="session-supplier-label">
        <span>{t('sessionSupplier.label', 'Supplier')}</span>
        <select
          aria-label={t('sessionSupplier.label', 'Supplier')}
          value={selectedId ?? ''}
          disabled={pending}
          onChange={event => request(event.target.value)}
        >
          {missing && <option value={selectedId ?? ''} disabled>{t('sessionSupplier.choose', 'Select a supplier')}</option>}
          {suppliers.map(entry => <option key={entry.id} value={entry.id} disabled={!entry.available}>{entry.name}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => request()} disabled={pending} aria-label={t('common.refresh', 'Refresh')}>
        <span aria-hidden="true" className={`codicon codicon-${pending ? 'loading codicon-modifier-spin' : 'refresh'}`} />
      </button>
      <span role="status" className={error || (missing && !pending) ? 'session-supplier-error' : undefined}>
        {error ? t('sessionSupplier.unavailable', 'Supplier unavailable. Refresh or select another supplier.')
          : deferred ? t('sessionSupplier.nextTurn', 'Applies to the next turn')
            : missing && !pending ? t('sessionSupplier.choose', 'Select a supplier') : ''}
      </span>
    </div>
  );
}
