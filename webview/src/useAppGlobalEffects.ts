import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { preloadSlashCommands, forceRefreshPrompts } from './components/ChatInputBox/providers';
import { applyDiffTheme, getStoredDiffTheme } from './utils/diffTheme';
import { collectTaskEventsFromMessages } from './utils/taskNotificationMessage';
import type { ClaudeMessage } from './types';
import type { ChatScreenProps } from './components/ChatScreen';
import { useMessages } from './contexts/MessagesContext';
import { useUIState } from './contexts/UIStateContext';
import { useSetTaskEvents } from './contexts/SubagentContext';

/** Subset of useModelProviderState's return consumed by these effects. */
export interface AppGlobalEffectsModelSlice {
  currentProvider: string;
  currentSdkInstalled: boolean;
  claudeSdkMeetsMinimum: boolean | undefined;
  selectedModel: ChatScreenProps['selectedModel'];
}

interface UseAppGlobalEffectsOptions {
  model: AppGlobalEffectsModelSlice;
}

/**
 * App-level side effects extracted verbatim from App.tsx: diff-theme bootstrap,
 * external drag/drop interception, in-conversation search hotkey, slash-command
 * preloading, task-event recovery from task-notification messages, and the
 * Fable SDK-minimum warning. Context values are consumed directly here
 * (same convention as ChatScreen / AppDialogs).
 */
export const useAppGlobalEffects = ({ model }: UseAppGlobalEffectsOptions) => {
  const { t } = useTranslation();
  const { messages } = useMessages();
  const setTaskEvents = useSetTaskEvents();
  const {
    currentView, setCurrentView,
    setSettingsInitialTab,
    addToast,
    searchOpen, setSearchOpen,
  } = useUIState();
  const {
    currentProvider, currentSdkInstalled, claudeSdkMeetsMinimum, selectedModel,
  } = model;

  // ── First-mount gate for the prompt-refresh effect below ──
  const isFirstMountRef = useRef(true);

  // Apply diff theme on app startup so diff styles work before opening Settings.
  useEffect(() => {
    const ideTheme = window.__INITIAL_IDE_THEME__ ?? null;
    applyDiffTheme(getStoredDiffTheme(), ideTheme);
  }, []);

  // ── Global drag event interception ──
  useEffect(() => {
    const preventExternalDrop = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? []);
      const isExternalDrop = types.includes('Files') || types.includes('text/uri-list');
      if (!isExternalDrop) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('dragover', preventExternalDrop);
    document.addEventListener('drop', preventExternalDrop);
    document.addEventListener('dragenter', preventExternalDrop);
    return () => {
      document.removeEventListener('dragover', preventExternalDrop);
      document.removeEventListener('drop', preventExternalDrop);
      document.removeEventListener('dragenter', preventExternalDrop);
    };
  }, []);

  // ── Close in-conversation search panel when navigating away from chat ──
  // Split from the hotkey effect below so that toggling `searchOpen` does
  // NOT rebind the global keydown listener every time the panel opens/closes.
  useEffect(() => {
    if (currentView !== 'chat' && searchOpen) {
      setSearchOpen(false);
    }
  }, [currentView, searchOpen, setSearchOpen]);

  // ── In-conversation search hotkey (Cmd+F on macOS, Ctrl+F elsewhere) ──
  // Only active in chat view. Settings / history use their own search
  // (HistoryFilters) or none at all — we deliberately let the platform
  // handle Cmd+F there.
  //
  // We deliberately listen for ONLY the platform-appropriate modifier:
  // macOS users use Ctrl+F as the Emacs-style "forward-char" cursor move,
  // so we MUST NOT capture Ctrl+F on macOS. This is a real regression
  // surfaced by code review.
  //
  // Platform detection prefers `navigator.userAgentData.platform` (modern,
  // non-deprecated) and falls back to `userAgent` string sniffing for
  // JCEF / older Chromium where userAgentData may be unavailable.
  // `navigator.platform` is intentionally NOT used — it is deprecated and
  // returns inconsistent values inside JCEF.
  useEffect(() => {
    if (currentView !== 'chat') return;
    const isMac = (() => {
      if (typeof navigator === 'undefined') return false;
      const uaData = (navigator as Navigator & {
        userAgentData?: { platform?: string };
      }).userAgentData;
      const platform = uaData?.platform ?? navigator.userAgent ?? '';
      return /mac|iphone|ipad|ipod/i.test(platform);
    })();
    const handler = (e: KeyboardEvent) => {
      const key = e.key;
      if (key !== 'f' && key !== 'F') return;
      const isFind = isMac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
      if (!isFind) return;
      // Don't fight IME composition.
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
    // setSearchOpen is a stable useState setter; intentionally omitted from
    // deps so we don't rebind the global listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView]);

  // ── Slash command preloading ──
  useEffect(() => {
    preloadSlashCommands();
    forceRefreshPrompts();
    const retryTimer = setTimeout(() => { forceRefreshPrompts(); }, 1000);
    return () => clearTimeout(retryTimer);
  }, []);

  useEffect(() => {
    if (isFirstMountRef.current) { isFirstMountRef.current = false; return; }
    if (currentView === 'chat') { forceRefreshPrompts(); }
  }, [currentView]);

  // Recover task events from task-notification user messages. Recent Claude Code
  // delivers a background agent's terminal report as a plain user message (XML
  // in content) instead of an SDK task_notification event, so history replay —
  // and any live session that never fired the SDK path — would otherwise leave
  // the subagent card stuck on the launch ack text. Derived entries only fill
  // gaps: a real SDK event already in the map is kept as-is.
  // Messages update immutably, so unchanged messages keep their object identity;
  // tracking scanned objects avoids re-scanning the whole conversation on every
  // streaming chunk.
  const scannedTaskNotificationMessagesRef = useRef(new WeakSet<ClaudeMessage>());
  useEffect(() => {
    const scanned = scannedTaskNotificationMessagesRef.current;
    const fresh = messages.filter((m) => !scanned.has(m));
    if (fresh.length === 0) return;
    for (const m of fresh) scanned.add(m);
    const derived = collectTaskEventsFromMessages(fresh);
    if (Object.keys(derived).length === 0) return;
    setTaskEvents((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, event] of Object.entries(derived)) {
        if (next[id]) continue;
        next[id] = event;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [messages, setTaskEvents]);

  const handleNavigateToSdkSettings = useCallback(() => {
    setSettingsInitialTab('dependencies');
    setCurrentView('settings');
  }, [setSettingsInitialTab, setCurrentView]);

  // Warn once when the installed Claude SDK is below the Fable minimum (0.3.182)
  // and the Fable tier is selected. Old CLIs don't recognize the 'fable' alias
  // and pass it through as a literal model name, which 401s on third-party relays
  // ("model fable" / "No available channel"). `claudeSdkMeetsMinimum` is `undefined`
  // until the backend reports status or when the SDK isn't installed — never warn
  // in those cases to avoid false positives.
  const fableSdkWarningShownRef = useRef(false);
  useEffect(() => {
    if (
      currentProvider === 'claude' &&
      currentSdkInstalled &&
      claudeSdkMeetsMinimum === false &&
      /fable/i.test(selectedModel ?? '') &&
      !fableSdkWarningShownRef.current
    ) {
      fableSdkWarningShownRef.current = true;
      addToast(t('chat.sdkTooLowForFable'), 'warning', {
        label: t('chat.updateSdk'),
        onClick: handleNavigateToSdkSettings,
      });
    }
  }, [currentProvider, currentSdkInstalled, claudeSdkMeetsMinimum, selectedModel, addToast, t, handleNavigateToSdkSettings]);
};
