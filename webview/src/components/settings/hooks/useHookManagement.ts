import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  HookCatalog,
  HookEditorTarget,
  HookItem,
  HookMutationResult,
  HookSourcePayload,
  HookToggleResult,
} from '../../../types/hooks';
import { EMPTY_HOOK_CATALOG } from '../../../types/hooks';
import { sendBridgeEvent } from '../../../utils/bridge';

const REQUEST_TIMEOUT_MS = 5000;
const TOGGLE_TIMEOUT_MS = 5000;

function targetLocation(target: HookEditorTarget): string {
  return 'rawLocation' in target ? target.rawLocation : target.location;
}

interface HookEditorState {
  item: HookEditorTarget;
  content: string | null;
  revision: string;
  backupDirectory: string | null;
  lastModified: number | null;
}

export interface UseHookManagementReturn {
  catalog: HookCatalog;
  hooksLoading: boolean;
  loadHooks: () => void;
  updateHooks: (catalog: HookCatalog) => void;
  editor: HookEditorState | null;
  sourceLoading: boolean;
  mutationLoading: boolean;
  loadHookSource: (item: HookEditorTarget) => void;
  reloadHookSource: () => void;
  saveHookSource: (content: string) => void;
  restoreHookSource: () => void;
  canRestore: boolean;
  lastBackupPath: string | null;
  sourceError: string | null;
  mutationError: string | null;
  toggleLoadingId?: string | null;
  toggleError?: string | null;
  toggleHook?: (item: HookItem, enabled: boolean, confirmSharedChange?: boolean) => void;
  updateHookSource: (payload: HookSourcePayload) => void;
  updateHookMutationResult: (payload: HookMutationResult) => void;
  updateHookToggleResult?: (payload: HookToggleResult) => void;
}

export function useHookManagement(): UseHookManagementReturn {
  const [catalog, setCatalog] = useState<HookCatalog>(EMPTY_HOOK_CATALOG);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [editor, setEditor] = useState<HookEditorState | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [lastBackupPath, setLastBackupPath] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [toggleLoadingId, setToggleLoadingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toggleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toggleRequestRef = useRef<string | null>(null);
  const catalogRequestRef = useRef<string | null>(null);
  const toggleRefreshPendingRef = useRef(false);

  const sourceRequestRef = useRef<string | null>(null);
  const mutationRequestRef = useRef<{ requestId: string; location: string } | null>(null);
  const mutationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSequenceRef = useRef(0);
  const requestPrefix = useId();
  const expiredMutations = useRef(new Map<string, string>());
  const expiredToggles = useRef(new Set<string>());

  const rememberMutation = useCallback(() => {
    const pending = mutationRequestRef.current;
    if (pending) {
      expiredMutations.current.set(pending.requestId, pending.location);
      if (expiredMutations.current.size > 20) expiredMutations.current.delete(expiredMutations.current.keys().next().value!);
    }
    mutationRequestRef.current = null;
    if (mutationTimeoutRef.current) clearTimeout(mutationTimeoutRef.current);
    mutationTimeoutRef.current = null;
  }, []);

  useEffect(() => () => {
    for (const timer of [timeoutRef.current, sourceTimeoutRef.current, toggleTimeoutRef.current, mutationTimeoutRef.current]) {
      if (timer) clearTimeout(timer);
    }
    sourceRequestRef.current = null;
    mutationRequestRef.current = null;
    toggleRequestRef.current = null;
    expiredMutations.current.clear();
    expiredToggles.current.clear();
  }, []);

  const finishToggleRefresh = useCallback((error?: string) => {
    if (!toggleRefreshPendingRef.current) return;
    toggleRefreshPendingRef.current = false;
    toggleRequestRef.current = null;
    setToggleLoadingId(null);
    if (error) setToggleError(error);
  }, []);

  const loadHooks = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const requestId = `${requestPrefix}-catalog-${++requestSequenceRef.current}`;
    catalogRequestRef.current = requestId;
    setHooksLoading(true);
    timeoutRef.current = setTimeout(() => {
      catalogRequestRef.current = null;
      setHooksLoading(false);
      timeoutRef.current = null;
      finishToggleRefresh('HOOK_CATALOG_TIMEOUT');
    }, REQUEST_TIMEOUT_MS);
    if (!sendBridgeEvent('get_hooks', JSON.stringify({ requestId }))) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      catalogRequestRef.current = null;
      setHooksLoading(false);
      finishToggleRefresh('BRIDGE_UNAVAILABLE');
      return;
    }
  }, [finishToggleRefresh, requestPrefix]);

  const updateHooks = useCallback((nextCatalog: HookCatalog) => {
    if (catalogRequestRef.current ? nextCatalog.requestId !== catalogRequestRef.current : nextCatalog.requestId) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    catalogRequestRef.current = null;
    setCatalog({ ...nextCatalog, capabilities: nextCatalog.capabilities ?? [] });
    setHooksLoading(false);
    finishToggleRefresh();
  }, [finishToggleRefresh]);

  const requestSource = useCallback((item: HookEditorTarget) => {
    if (sourceTimeoutRef.current) clearTimeout(sourceTimeoutRef.current);
    const requestId = `${requestPrefix}-source-${++requestSequenceRef.current}`;
    sourceRequestRef.current = requestId;
    setSourceLoading(true);
    setSourceError(null);
    if (!sendBridgeEvent('get_hook_source', JSON.stringify({ location: targetLocation(item), requestId }))) {
      sourceRequestRef.current = null;
      setSourceLoading(false);
      setSourceError('BRIDGE_UNAVAILABLE');
      return;
    }
    sourceTimeoutRef.current = setTimeout(() => {
      sourceRequestRef.current = null;
      sourceTimeoutRef.current = null;
      setSourceLoading(false);
      setSourceError('HOOK_SOURCE_TIMEOUT');
    }, REQUEST_TIMEOUT_MS);
  }, [requestPrefix]);

  const loadHookSource = useCallback((item: HookEditorTarget) => {
    rememberMutation();
    setMutationLoading(false);
    setLastBackupPath(null);
    setMutationError(null);
    setEditor({ item, content: null, revision: item.revision, backupDirectory: null, lastModified: item.lastModified ?? null });
    requestSource(item);
  }, [rememberMutation, requestSource]);

  const reloadHookSource = useCallback(() => {
    if (editor && !mutationRequestRef.current) requestSource(editor.item);
  }, [editor, requestSource]);

  const updateHookSource = useCallback((payload: HookSourcePayload) => {
    if (!payload.requestId || payload.requestId !== sourceRequestRef.current) return;
    if (payload.location && editor && payload.location !== targetLocation(editor.item)) return;
    if (sourceTimeoutRef.current) clearTimeout(sourceTimeoutRef.current);
    sourceTimeoutRef.current = null;
    sourceRequestRef.current = null;
    setSourceLoading(false);
    if (!payload.success || !payload.location || payload.content === undefined || !payload.revision) {
      setSourceError(payload.errorCode ?? 'READ_FAILED');
      return;
    }
    setSourceError(null);
    setMutationError(null);
    setEditor(current => current ? {
      ...current,
      content: payload.content!,
      revision: payload.revision!,
      backupDirectory: payload.backupDirectory ?? current.backupDirectory,
      lastModified: payload.lastModified ?? current.lastModified,
    } : current);
  }, [editor]);

  const mutateSource = useCallback((command: string, location: string, fields: Record<string, string>) => {
    if (mutationRequestRef.current) return;
    const requestId = `${requestPrefix}-mutation-${++requestSequenceRef.current}`;
    mutationRequestRef.current = { requestId, location };
    setMutationLoading(true);
    setSourceError(null);
    setMutationError(null);
    if (!sendBridgeEvent(command, JSON.stringify({ ...fields, requestId }))) {
      mutationRequestRef.current = null;
      setMutationLoading(false);
      setMutationError('BRIDGE_UNAVAILABLE');
      return;
    }
    mutationTimeoutRef.current = setTimeout(() => {
      rememberMutation();
      setMutationLoading(false);
      setMutationError('HOOK_MUTATION_TIMEOUT');
    }, REQUEST_TIMEOUT_MS);
  }, [rememberMutation, requestPrefix]);

  const saveHookSource = useCallback((content: string) => {
    if (!editor || editor.content === null || sourceRequestRef.current) return;
    const location = targetLocation(editor.item);
    mutateSource('save_hook_source', location, { location, expectedRevision: editor.revision, content });
  }, [editor, mutateSource]);

  const restoreHookSource = useCallback(() => {
    if (!editor || !lastBackupPath || sourceRequestRef.current) return;
    const location = targetLocation(editor.item);
    mutateSource('restore_hook_source', location, { location, expectedRevision: editor.revision, backupPath: lastBackupPath });
  }, [editor, lastBackupPath, mutateSource]);

  const updateHookMutationResult = useCallback((payload: HookMutationResult) => {
    const pending = mutationRequestRef.current;
    if (!payload.requestId || payload.requestId !== pending?.requestId) {
      const location = payload.requestId ? expiredMutations.current.get(payload.requestId) : undefined;
      if (location) {
        expiredMutations.current.delete(payload.requestId!);
        if (payload.success) {
          loadHooks();
          if (!pending && editor && targetLocation(editor.item) === location) setMutationError('HOOK_MUTATION_CONFIRMED_LATE');
        }
      }
      return;
    }
    if (payload.location && payload.location !== pending.location) return;
    if (mutationTimeoutRef.current) clearTimeout(mutationTimeoutRef.current);
    mutationTimeoutRef.current = null;
    mutationRequestRef.current = null;
    setMutationLoading(false);
    if (!payload.success) {
      setMutationError(payload.errorCode ?? 'UNKNOWN_ERROR');
      return;
    }
    if (editor && payload.revision) {
      setEditor({ ...editor, revision: payload.revision, content: payload.content ?? editor.content,
        lastModified: payload.lastModified ?? editor.lastModified });
      setLastBackupPath(payload.backupPath ?? null);
      loadHooks();
    }
  }, [editor, loadHooks]);

  const toggleHook = useCallback((item: HookItem, enabled: boolean, confirmSharedChange = false) => {
    if ((!item.toggleSupported && !item.managedToggleSupported) || toggleRequestRef.current !== null) return;
    setToggleLoadingId(item.sourceId);
    setToggleError(null);
    const requestId = `${requestPrefix}-toggle-${++requestSequenceRef.current}`;
    toggleRequestRef.current = requestId;
    const sent = sendBridgeEvent('toggle_hook', JSON.stringify({
      requestId, provider: item.provider, scope: item.scope, event: item.event, matcher: item.matcher,
      sourceId: item.sourceId, managedKey: item.managedKey, nativeStateRevision: item.nativeStateRevision,
      format: item.format, location: item.rawLocation, expectedRevision: item.revision, enabled, confirmSharedChange,
    }));
    if (!sent) {
      setToggleLoadingId(null);
      toggleRequestRef.current = null;
      setToggleError('BRIDGE_UNAVAILABLE');
      return;
    }
    toggleTimeoutRef.current = setTimeout(() => {
      expiredToggles.current.add(requestId);
      if (expiredToggles.current.size > 20) expiredToggles.current.delete(expiredToggles.current.values().next().value!);
      setToggleLoadingId(null);
      setToggleError('HOOK_TOGGLE_TIMEOUT');
      toggleRequestRef.current = null;
      toggleTimeoutRef.current = null;
    }, TOGGLE_TIMEOUT_MS);
  }, [requestPrefix]);

  const updateHookToggleResult = useCallback((payload: HookToggleResult) => {
    if (!payload.requestId || payload.requestId !== toggleRequestRef.current) {
      if (payload.requestId && expiredToggles.current.delete(payload.requestId) && payload.success) loadHooks();
      return;
    }
    if (toggleRefreshPendingRef.current) return;
    if (toggleTimeoutRef.current) clearTimeout(toggleTimeoutRef.current);
    toggleTimeoutRef.current = null;
    if (!payload.success) {
      setToggleLoadingId(null);
      toggleRequestRef.current = null;
      setToggleError(payload.errorCode ?? 'HOOK_TOGGLE_FAILED');
      return;
    }
    setToggleError(null);
    toggleRefreshPendingRef.current = true;
    loadHooks();
  }, [loadHooks]);

  return {
    catalog,
    hooksLoading,
    loadHooks,
    updateHooks,
    editor,
    sourceLoading,
    mutationLoading,
    loadHookSource,
    reloadHookSource,
    saveHookSource,
    restoreHookSource,
    canRestore: Boolean(lastBackupPath),
    lastBackupPath,
    sourceError,
    mutationError,
    toggleLoadingId,
    toggleError,
    toggleHook,
    updateHookSource,
    updateHookMutationResult,
    updateHookToggleResult,
  };
}
