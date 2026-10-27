/**
 * sessionCallbacks.ts
 *
 * Registers window bridge callbacks for session management, SDK dependency status,
 * and rewind result: setSessionId, addToast, onExportSessionData,
 * updateDependencyStatus, onRewindResult.
 */

import type { MutableRefObject } from 'react';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { downloadJSON } from '../../../utils/exportMarkdown';
import { releaseSessionTransition } from '../sessionTransition';
import { drainPendingDependencyStatus } from '../settingsBootstrap';
import { sendBridgeEvent } from '../../../utils/bridge';
import {
  isDependencyStatusResponse,
  settleDependencyStatusRequest,
} from '../../../utils/bridgeStartup';

// Matches session-titles-service.cjs#updateTitle, which rejects longer titles.
const CUSTOM_TITLE_MAX_LENGTH = 50;

// Stable backend failure codes -> friendly toast copy. Unknown codes fall back
// to the generic message (with the raw error appended when present).
const TITLE_REGENERATION_ERROR_KEYS: Record<string, string> = {
  empty_session: 'history.titleRegenerateFailed.emptySession',
  disabled: 'history.titleRegenerateFailed.disabled',
  session_not_found: 'history.titleRegenerateFailed.sessionNotFound',
  generation_failed: 'history.titleRegenerateFailed.generationFailed',
};

export function registerSessionAndSdkCallbacks(
  options: UseWindowCallbacksOptions,
  tRef: MutableRefObject<UseWindowCallbacksOptions['t']>,
): void {
  const {
    addToast,
    setCurrentSessionId,
    setSdkStatus,
    setSdkStatusLoaded,
    setSdkStatusError,
    setIsRewinding,
    setRewindDialogOpen,
    setCurrentRewindRequest,
    customSessionTitleRef,
    currentSessionIdRef,
    updateHistoryTitle,
    applyHistoryTitleLocal,
    setCustomSessionTitle,
    settleTitleRegeneration,
  } = options;

  window.setSessionId = (sessionId: string) => {
    const oldId = currentSessionIdRef.current;
    releaseSessionTransition();
    // Java sends an empty ID when a restored transcript expires. Keep the
    // canonical no-session state and wait for a real ID before migrating titles.
    currentSessionIdRef.current = sessionId || null;
    setCurrentSessionId(sessionId || null);
    if (!sessionId) return;

    // B-011 + B-014: Persist custom title under the real SDK session ID.
    // NOTE: We intentionally do NOT delete the old ID's title to prevent
    // data loss when Codex creates new threads for continued conversations.
    // Orphaned title entries are harmless and cleaned up on session deletion.
    const title = customSessionTitleRef.current;
    if (title && oldId !== sessionId) {
      // AI-generated titles can exceed the backend limit. Fall back to
      // local-only update so the UI keeps the title visible without a
      // silent backend write failure.
      if (title.length <= CUSTOM_TITLE_MAX_LENGTH) {
        updateHistoryTitle(sessionId, title);
      } else {
        applyHistoryTitleLocal(sessionId, title);
      }
    }
  };

  // The ready replay can precede this effect; controls need that identity before their first dispatch.
  if (typeof window.__pendingSessionId === 'string') {
    const sessionId = window.__pendingSessionId;
    delete window.__pendingSessionId;
    window.setSessionId(sessionId);
  }

  window.addToast = (message, type) => {
    addToast(message, type as 'info' | 'success' | 'warning' | 'error' | undefined);
  };

  window.onExportSessionData = (json) => {
    try {
      const data = JSON.parse(json);
      if (data.sessionId && data.messages) {
        const exportContent = JSON.stringify(data, null, 2);
        const sanitizedTitle = (data.title || 'session')
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\s+/g, '_')
          .substring(0, 50);
        const filename = `${sanitizedTitle}_${data.sessionId.substring(0, 8)}.json`;
        downloadJSON(exportContent, filename);
      } else if (data.error) {
        addToast(data.error, 'error');
      } else {
        addToast(tRef.current('history.exportFailed'), 'error');
      }
    } catch (error) {
      console.error('[Frontend] Failed to process export data:', error);
      addToast(tRef.current('history.exportFailed'), 'error');
    }
  };

  // =========================================================================
  // SDK Status Callbacks
  // =========================================================================

  const originalUpdateDependencyStatus = window.updateDependencyStatus;
  window.updateDependencyStatus = (jsonStr: string) => {
    try {
      const data = JSON.parse(jsonStr);
      if (!isDependencyStatusResponse(data)) {
        console.error('[Frontend] Dependency status request failed:', data);
        const error = typeof data.error === 'string' && data.error.trim()
          ? data.error
          : 'dependency_status_unavailable';
        setSdkStatusLoaded(false);
        setSdkStatusError(error);
        settleDependencyStatusRequest('error');
        return;
      }
      setSdkStatus(data);
      setSdkStatusLoaded(true);
      setSdkStatusError(null);
      settleDependencyStatusRequest('ready');
    } catch (error) {
      console.error('[Frontend] Failed to parse dependency status:', error);
      setSdkStatusLoaded(false);
      setSdkStatusError(error instanceof Error ? error.message : 'invalid_dependency_status');
      settleDependencyStatusRequest('error');
    }
    if (
      originalUpdateDependencyStatus &&
      originalUpdateDependencyStatus !== window.updateDependencyStatus
    ) {
      originalUpdateDependencyStatus(jsonStr);
    }
  };
  (window as unknown as Record<string, unknown>)._appUpdateDependencyStatus =
    window.updateDependencyStatus;

  drainPendingDependencyStatus();

  // =========================================================================
  // Rewind Result Callback
  // =========================================================================

  window.onRewindResult = (json: string) => {
    try {
      const result = JSON.parse(json);
      setIsRewinding(false);
      if (result.success) {
        setRewindDialogOpen(false);
        setCurrentRewindRequest(null);
        window.addToast?.(tRef.current('rewind.success'), 'success');
      } else {
        window.addToast?.(result.message || tRef.current('rewind.failed'), 'error');
      }
    } catch (error) {
      console.error('[Frontend] Failed to parse rewind result:', error);
      setIsRewinding(false);
      setRewindDialogOpen(false);
      setCurrentRewindRequest(null);
      window.addToast?.(tRef.current('rewind.parseError'), 'error');
    }
  };

  // =========================================================================
  // AI Title Callback
  // =========================================================================

  window.updateSessionTitle = (sessionId: string, title: string) => {
    if (!title || !title.trim() || !sessionId) return;
    // Only apply the title if it matches the current session to prevent
    // stale events from overwriting the wrong session's title.
    if (currentSessionIdRef.current !== sessionId) return;
    const trimmed = title.trim();
    // Automatic titles go to restoredSessionTitle, never to
    // customSessionTitle: that slot is reserved for manual edits and the
    // persisted custom title. Keeping the two apart means a later AI title can
    // never overwrite a manual title, and restoreSessionTitle never mistakes an
    // AI title for a manual edit.
    options.setRestoredSessionTitle({ sessionId, title: trimmed });
    if (!customSessionTitleRef.current) applyHistoryTitleLocal(sessionId, trimmed);
  };

  // =========================================================================
  // Persisted Custom Title Callback
  // =========================================================================

  /**
   * Applies the user-set title saved in session-titles.json after a webview
   * restart. A restored transcript only carries the CLI-derived title, so the
   * header would otherwise show the old AI title until the session is reopened
   * from the history list.
   */
  window.restoreSessionTitle = (sessionId: string, title: string) => {
    if (!title || !title.trim() || !sessionId) return;
    // Only a title keyed to the session on screen may show; a stale push for a
    // previously opened session must not retitle the current one.
    if (currentSessionIdRef.current !== sessionId) return;
    // customSessionTitle carries only manual edits and persisted titles, so a
    // nonempty value is a newer manual edit that must win over this restore.
    if (customSessionTitleRef.current) return;
    setCustomSessionTitle(title.trim());
  };

  // Apply a title that arrived before this effect mounted (see main.tsx).
  if (window.__pendingRestoreSessionTitle) {
    const pending = window.__pendingRestoreSessionTitle;
    delete window.__pendingRestoreSessionTitle;
    window.restoreSessionTitle?.(pending.sessionId, pending.title);
  }

  // =========================================================================
  // AI Title Regeneration Result Callback (refresh buttons)
  // =========================================================================

  // Registered once for the app lifetime (unlike the per-view registration the
  // history list originally used) so the chat-header refresh button also
  // receives its result while the history view is not mounted.
  window.onTitleRegenerated = (json: string) => {
    let payload: { sessionId?: string; success?: boolean; title?: string; code?: string; error?: string };
    try {
      payload = JSON.parse(json);
    } catch {
      return;
    }
    if (!payload.sessionId) return;

    const sessionId = payload.sessionId;
    settleTitleRegeneration(sessionId);

    if (payload.success && payload.title) {
      applyHistoryTitleLocal(sessionId, payload.title);
      addToast(tRef.current('history.titleRegenerated'), 'success');
      return;
    }
    // The chat-header title of the current session updates through the
    // title_generated daemon event (updateSessionTitle above); failures keep
    // the original title untouched, so only the toast is needed here.
    const reasonKey = payload.code ? TITLE_REGENERATION_ERROR_KEYS[payload.code] : undefined;
    const message = reasonKey
      ? tRef.current(reasonKey)
      : payload.error
        ? `${tRef.current('history.titleRegenerateFailed.generic')}: ${payload.error}`
        : tRef.current('history.titleRegenerateFailed.generic');
    addToast(message, 'error');
  };

  // =========================================================================
  // SDK-to-CLI Session Conversion Result Callback
  // =========================================================================

  window.onConversionResult = (json: string) => {
    // The optimistic update already flipped the entrypoint to 'cli'; reloading
    // restores the real on-disk state (confirming success or rolling back failure).
    const reloadHistory = () => {
      const provider = options.currentProviderRef.current;
      if (provider) {
        sendBridgeEvent('deep_search_history', provider);
      } else {
        console.warn('[Frontend] Provider unavailable for conversion state reload');
      }
    };

    try {
      const result = JSON.parse(json);
      if (result.success) {
        if (result.infoCode === 'ALREADY_CLI_SESSION') {
          // Already a CLI session - the optimistic update was correct, no reload needed
          addToast(tRef.current('history.conversionErrors.ALREADY_CLI_SESSION'), 'info');
        } else {
          // Actually converted - show success and reload to get updated index
          addToast(tRef.current('history.convertSuccess'), 'success');
          reloadHistory();
        }
        return;
      }

      // Failure path: translate error code and show error message
      const errorCode = result.errorCode;
      let errorMessage = tRef.current('history.convertFailed');

      if (errorCode && tRef.current(`history.conversionErrors.${errorCode}`)) {
        errorMessage = tRef.current(`history.conversionErrors.${errorCode}`);
      }

      addToast(errorMessage, 'error');

      // Always reload on failure: the optimistic update made the convert button
      // disappear, so without a rollback the user could neither retry (FILE_LOCKED)
      // nor see the session's true entrypoint.
      reloadHistory();
    } catch (error) {
      console.error('[Frontend] Failed to parse conversion result:', error);
      addToast(tRef.current('history.convertFailed'), 'error');
      reloadHistory();
    }
  };
}
