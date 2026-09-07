import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ToastAction, ToastMessage } from '../components/Toast';
import type { SettingsTab } from '../components/settings/SettingsSidebar';
import type { ProviderManageTab } from '../components/settings/ProviderTabSection';
import type { ContextInfo, ViewMode } from '../hooks';
import { APP_VERSION } from '../version/version';
import { DEFAULT_STATUS } from './MessagesContext';
import { forceWebviewRepaint } from '../utils/forceWebviewRepaint';

const LAST_SEEN_VERSION_KEY = 'lastSeenChangelogVersion';

export interface UIStateContextValue {
  // Navigation
  currentView: ViewMode;
  setCurrentView: React.Dispatch<React.SetStateAction<ViewMode>>;
  settingsInitialTab: SettingsTab | undefined;
  setSettingsInitialTab: React.Dispatch<React.SetStateAction<SettingsTab | undefined>>;
  /** Deep link into Settings → Providers sub-tab (claude/codex/cli) */
  settingsProviderSubTab: ProviderManageTab | undefined;
  setSettingsProviderSubTab: React.Dispatch<React.SetStateAction<ProviderManageTab | undefined>>;

  // Toasts
  toasts: ToastMessage[];
  addToast: (message: string, type?: ToastMessage['type'], action?: ToastAction) => void;
  dismissToast: (id: string) => void;
  clearToasts: () => void;

  // Misc dialogs that don't belong to useDialogManagement
  addModelDialogOpen: boolean;
  setAddModelDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  showChangelogDialog: boolean;
  closeChangelogDialog: () => void;
  openChangelogDialog: () => void;

  // Active editor context (file + selection)
  contextInfo: ContextInfo | null;
  setContextInfo: React.Dispatch<React.SetStateAction<ContextInfo | null>>;

  // Chat input draft (kept here for cross-view persistence)
  draftInput: string;
  setDraftInput: React.Dispatch<React.SetStateAction<string>>;

  // In-conversation search panel (Cmd/Ctrl+F)
  searchOpen: boolean;
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const UIStateContext = createContext<UIStateContextValue | null>(null);

/**
 * Provides view-level UI state: navigation (currentView), toast queue,
 * miscellaneous dialogs, active editor context info, and the chat input draft.
 *
 * Stage 3 of TASK-P1-01.
 */
export function UIStateProvider({ children }: { children: ReactNode }) {
  const [currentView, setCurrentView] = useState<ViewMode>('chat');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  const [settingsProviderSubTab, setSettingsProviderSubTab] = useState<ProviderManageTab | undefined>(undefined);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [addModelDialogOpen, setAddModelDialogOpen] = useState<boolean>(false);
  const [showChangelogDialog, setShowChangelogDialog] = useState<boolean>(() => {
    const lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
    return lastSeen !== APP_VERSION;
  });
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [draftInput, setDraftInput] = useState<string>('');
  const [searchOpen, setSearchOpen] = useState<boolean>(false);

  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info', action?: ToastAction) => {
    if (message === DEFAULT_STATUS || !message) return;
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type, action }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const clearToasts = useCallback(() => { setToasts([]); }, []);

  const closeChangelogDialog = useCallback(() => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION);
    setShowChangelogDialog(false);
    // The fixed-position fullscreen overlay can leave ghosting after unmount on macOS JCEF.
    forceWebviewRepaint('changelog-dialog-close');
  }, []);

  const openChangelogDialog = useCallback(() => { setShowChangelogDialog(true); }, []);

  const value = useMemo<UIStateContextValue>(
    () => ({
      currentView, setCurrentView,
      settingsInitialTab, setSettingsInitialTab,
      settingsProviderSubTab, setSettingsProviderSubTab,
      toasts, addToast, dismissToast, clearToasts,
      addModelDialogOpen, setAddModelDialogOpen,
      showChangelogDialog, closeChangelogDialog, openChangelogDialog,
      contextInfo, setContextInfo,
      draftInput, setDraftInput,
      searchOpen, setSearchOpen,
    }),
    [
      currentView, settingsInitialTab,
      settingsProviderSubTab,
      toasts, addToast, dismissToast, clearToasts,
      addModelDialogOpen,
      showChangelogDialog, closeChangelogDialog, openChangelogDialog,
      contextInfo, draftInput,
      searchOpen,
    ],
  );

  return <UIStateContext.Provider value={value}>{children}</UIStateContext.Provider>;
}

export function useUIState(): UIStateContextValue {
  const ctx = useContext(UIStateContext);
  if (ctx === null) {
    throw new Error('useUIState must be used within a UIStateProvider');
  }
  return ctx;
}

export { UIStateContext };
