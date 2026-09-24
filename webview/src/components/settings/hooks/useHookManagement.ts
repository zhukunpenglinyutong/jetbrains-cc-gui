import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HookCatalog,
  HookEditorTarget,
  HookItem,
  HookMutationResult,
  HookSourcePayload,
  HookToggleResult,
} from '../../../types/hooks';
import { EMPTY_HOOK_CATALOG } from '../../../types/hooks';
import { sendBridgeEvent, sendToJava } from '../../../utils/bridge';

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
  toggleHook?: (item: HookItem, enabled: boolean) => void;
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
  const toggleRequestSequenceRef = useRef(0);

  useEffect(() => () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    if (sourceTimeoutRef.current) {
      clearTimeout(sourceTimeoutRef.current);
    }
    if (toggleTimeoutRef.current) {
      clearTimeout(toggleTimeoutRef.current);
    }
  }, []);

  const loadHooks = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setHooksLoading(true);
    window.sendToJava?.('get_hooks:');
    timeoutRef.current = setTimeout(() => {
      setHooksLoading(false);
      timeoutRef.current = null;
    }, REQUEST_TIMEOUT_MS);
  }, []);

  const updateHooks = useCallback((nextCatalog: HookCatalog) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setCatalog({ ...nextCatalog, capabilities: nextCatalog.capabilities ?? [] });
    setHooksLoading(false);
  }, []);

  const loadHookSource = useCallback((item: HookEditorTarget) => {
    if (sourceTimeoutRef.current) {
      clearTimeout(sourceTimeoutRef.current);
    }
    setSourceLoading(true);
    setMutationLoading(false);
    setLastBackupPath(null);
    setSourceError(null);
    setMutationError(null);
    setEditor({
      item,
      content: null,
      revision: item.revision,
      backupDirectory: null,
      lastModified: item.lastModified ?? null,
    });
    sendToJava('get_hook_source', { location: targetLocation(item) });
    sourceTimeoutRef.current = setTimeout(() => {
      setSourceLoading(false);
      sourceTimeoutRef.current = null;
    }, REQUEST_TIMEOUT_MS);
  }, []);

  const reloadHookSource = useCallback(() => {
    if (!editor) {
      return;
    }
    if (sourceTimeoutRef.current) {
      clearTimeout(sourceTimeoutRef.current);
    }
    setSourceLoading(true);
    setSourceError(null);
    sendToJava('get_hook_source', { location: targetLocation(editor.item) });
    sourceTimeoutRef.current = setTimeout(() => {
      setSourceLoading(false);
      sourceTimeoutRef.current = null;
    }, REQUEST_TIMEOUT_MS);
  }, [editor]);

  const updateHookSource = useCallback((payload: HookSourcePayload) => {
    if (payload.location && editor && payload.location !== targetLocation(editor.item)) {
      return;
    }
    if (sourceTimeoutRef.current) {
      clearTimeout(sourceTimeoutRef.current);
      sourceTimeoutRef.current = null;
    }
    setSourceLoading(false);
    if (!payload.success || !payload.location || payload.content === undefined || !payload.revision) {
      setSourceError(payload.errorCode ?? 'READ_FAILED');
      return;
    }
    setSourceError(null);
    setMutationError(null);
    setEditor((current) => current
      ? {
        ...current,
        content: payload.content as string,
        revision: payload.revision as string,
        backupDirectory: payload.backupDirectory ?? current.backupDirectory,
        lastModified: payload.lastModified ?? current.lastModified,
      }
      : current);
  }, [editor]);

  const saveHookSource = useCallback((content: string) => {
    if (!editor || editor.content === null) {
      return;
    }
    setMutationLoading(true);
    setSourceError(null);
    setMutationError(null);
    sendToJava('save_hook_source', {
      location: targetLocation(editor.item),
      expectedRevision: editor.revision,
      content,
    });
  }, [editor]);

  const restoreHookSource = useCallback(() => {
    if (!editor || !lastBackupPath) {
      return;
    }
    setMutationLoading(true);
    setSourceError(null);
    setMutationError(null);
    sendToJava('restore_hook_source', {
      location: targetLocation(editor.item),
      expectedRevision: editor.revision,
      backupPath: lastBackupPath,
    });
  }, [editor, lastBackupPath]);

  const updateHookMutationResult = useCallback((payload: HookMutationResult) => {
    if (payload.location && editor && payload.location !== targetLocation(editor.item)) {
      return;
    }
    setMutationLoading(false);
    if (!payload.success) {
      setMutationError(payload.errorCode ?? 'UNKNOWN_ERROR');
      return;
    }
    if (payload.success && editor && payload.revision) {
      setEditor({
        ...editor,
        revision: payload.revision,
        content: payload.content ?? editor.content,
        lastModified: payload.lastModified ?? editor.lastModified,
      });
      setLastBackupPath(payload.backupPath ?? null);
      loadHooks();
    }
  }, [editor, loadHooks]);

  const toggleHook = useCallback((item: HookItem, enabled: boolean) => {
    if ((!item.toggleSupported && !item.managedToggleSupported) || toggleLoadingId !== null) {
      return;
    }
    setToggleLoadingId(item.sourceId);
    setToggleError(null);
    const requestId = `hook-toggle-${++toggleRequestSequenceRef.current}`;
    toggleRequestRef.current = requestId;
    const sent = sendBridgeEvent('toggle_hook', JSON.stringify({
      requestId,
      provider: item.provider,
      scope: item.scope,
      event: item.event,
      matcher: item.matcher,
      sourceId: item.sourceId,
      managedKey: item.managedKey,
      format: item.format,
      location: item.rawLocation,
      expectedRevision: item.revision,
      enabled,
    }));
    if (!sent) {
      setToggleLoadingId(null);
      toggleRequestRef.current = null;
      setToggleError('BRIDGE_UNAVAILABLE');
      return;
    }
    if (toggleTimeoutRef.current) {
      clearTimeout(toggleTimeoutRef.current);
    }
    toggleTimeoutRef.current = setTimeout(() => {
      setToggleLoadingId(null);
      setToggleError('HOOK_TOGGLE_TIMEOUT');
      toggleRequestRef.current = null;
      toggleTimeoutRef.current = null;
    }, TOGGLE_TIMEOUT_MS);
  }, [toggleLoadingId]);

  const updateHookToggleResult = useCallback((payload: HookToggleResult) => {
    if (!payload.requestId || payload.requestId !== toggleRequestRef.current) {
      return;
    }
    if (toggleTimeoutRef.current) {
      clearTimeout(toggleTimeoutRef.current);
      toggleTimeoutRef.current = null;
    }
    setToggleLoadingId(null);
    toggleRequestRef.current = null;
    if (!payload.success) {
      setToggleError(payload.errorCode ?? 'HOOK_TOGGLE_FAILED');
      return;
    }
    setToggleError(null);
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
