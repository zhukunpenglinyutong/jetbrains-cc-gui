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
import { CUSTOM_TITLE_MAX_LENGTH } from '../../../utils/sessionTitleLimit';

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
    loadHistorySessionRef,
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

    // A just-created fork carries the title the frontend requested, but its row
    // is not in the history list yet (or was stale when opened), so the header
    // would otherwise fall back to the message-derived title. Apply the pending
    // fork title the moment this session becomes active.
    const pendingForkTitle = window.__pendingForkTitle;
    if (pendingForkTitle && pendingForkTitle.sessionId === sessionId) {
      delete window.__pendingForkTitle;
      if (pendingForkTitle.title) {
        setCustomSessionTitle(pendingForkTitle.title);
        applyHistoryTitleLocal(sessionId, pendingForkTitle.title);
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

      if (errorCode) {
        // See the fork path: an empty default distinguishes a missing key from a
        // real translation, which i18next would otherwise return as the key.
        const translated = tRef.current(`history.conversionErrors.${errorCode}`, { defaultValue: '' });
        if (translated) {
          errorMessage = translated;
        }
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

  // =========================================================================
  // Session Fork Result Callback
  // =========================================================================

  /** Map a backend ForkResultCode to the localized message, with a generic fallback. */
  const translateForkError = (errorCode: string | undefined): string => {
    let errorMessage = tRef.current('history.forkFailed');
    if (errorCode) {
      // A missing key makes i18next echo the key itself, which is truthy; ask
      // for an empty default so an untranslated code falls back to the generic
      // message instead of leaking `history.forkErrors.XXX` into the toast.
      const translated = tRef.current(`history.forkErrors.${errorCode}`, { defaultValue: '' });
      if (translated) {
        errorMessage = translated;
      }
    }
    return errorMessage;
  };

  const handleForkSuccess = (
    result: { newSessionId?: string; forkPointUuid?: string },
    requestedTitle: string | undefined,
  ) => {
    // Consume the fork row's provider: the reload must query the store the fork
    // came from, and the panel's currentProvider can be stale after switching
    // chat providers without reopening the list (same reason delete requests
    // carry their row provider).
    const requestedProvider = window.__pendingForkProvider;
    delete window.__pendingForkProvider;
    // Reload so the fork row appears in the list. No optimistic insert: the
    // row's messageCount/fileSize are only known to the backend, and unlike
    // conversion there is no optimistic state to roll back on failure.
    const provider = requestedProvider || options.currentProviderRef.current;
    if (provider) {
      sendBridgeEvent('deep_search_history', provider);
    } else {
      console.warn('[Frontend] Provider unavailable for fork list reload');
    }

    // A fork created from an assistant message switches straight to the fork so
    // the user continues from that point; history-list forks keep the list open.
    // The transition clears toasts, so a message-level fork defers its success
    // toast until the switch completes (same mechanism as the delete toast);
    // adding it directly here would be wiped before a single frame renders.
    if (result.forkPointUuid && result.newSessionId) {
      // Only the auto-opened fork needs the pending title: setSessionId applies
      // it to the header, and the fork's row is not in the list yet. A
      // history-list fork keeps the title the backend wrote through the
      // custom-title service, so stashing it here would leave an unclaimed
      // global waiting for a session the user may never open.
      if (typeof requestedTitle === 'string') {
        window.__pendingForkTitle = {
          sessionId: result.newSessionId,
          title: requestedTitle,
        };
      }
      window.__pendingSessionTransitionToast = {
        message: tRef.current('history.forkSuccess'),
        type: 'success',
      };
      // Read through the ref: the closure would hold the mount-time
      // loadHistorySession, whose `loading` is permanently false, so a
      // mid-stream auto-open would skip the interrupt and clear messages
      // under the live reply (see UseWindowCallbacksOptions).
      loadHistorySessionRef?.current?.(result.newSessionId);
    } else {
      addToast(tRef.current('history.forkSuccess'), 'success');
    }
  };

  window.onForkResult = (json: string) => {
    // Release the one-fork-at-a-time guard on every outcome, including a
    // malformed payload that never reaches the try block below. The 60s
    // backstop timer goes with it, so a stale release cannot free a later
    // fork's guard early.
    window.__forkInFlight = false;
    if (window.__forkInFlightTimer != null) {
      clearTimeout(window.__forkInFlightTimer);
      delete window.__forkInFlightTimer;
    }
    try {
      const result = JSON.parse(json);
      if (result.success) {
        // Consume the requested title on every outcome: a result without a new
        // session id must not leave a stale title to be bound to some later fork.
        const requestedTitle = window.__pendingForkTitleRequest;
        delete window.__pendingForkTitleRequest;
        handleForkSuccess(result, requestedTitle);
        return;
      }

      addToast(translateForkError(result.errorCode), 'error');
      // The fork never produced a session: drop the title it was waiting to bind.
      delete window.__pendingForkTitleRequest;
      delete window.__pendingForkProvider;
    } catch (error) {
      console.error('[Frontend] Failed to parse fork result:', error);
      delete window.__pendingForkTitleRequest;
      delete window.__pendingForkProvider;
      addToast(tRef.current('history.forkFailed'), 'error');
    }
  };
}
