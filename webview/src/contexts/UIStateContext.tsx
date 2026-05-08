import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ToastMessage } from '../components/Toast';
import type { SettingsTab } from '../components/settings/SettingsSidebar';
import type { ContextInfo, ViewMode } from '../hooks';
import { APP_VERSION } from '../version/version';
import { DEFAULT_STATUS } from './MessagesContext';

const LAST_SEEN_VERSION_KEY = 'lastSeenChangelogVersion';

export interface UIStateContextValue {
  // Navigation
  currentView: ViewMode;
  setCurrentView: React.Dispatch<React.SetStateAction<ViewMode>>;
  settingsInitialTab: SettingsTab | undefined;
  setSettingsInitialTab: React.Dispatch<React.SetStateAction<SettingsTab | undefined>>;

  // Toasts
  toasts: ToastMessage[];
  addToast: (message: string, type?: ToastMessage['type']) => void;
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
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [addModelDialogOpen, setAddModelDialogOpen] = useState<boolean>(false);
  const [showChangelogDialog, setShowChangelogDialog] = useState<boolean>(() => {
    const lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
    return lastSeen !== APP_VERSION;
  });
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [draftInput, setDraftInput] = useState<string>('');

  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    if (message === DEFAULT_STATUS || !message) return;
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const clearToasts = useCallback(() => { setToasts([]); }, []);

  const closeChangelogDialog = useCallback(() => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION);
    setShowChangelogDialog(false);
  }, []);

  const openChangelogDialog = useCallback(() => { setShowChangelogDialog(true); }, []);

  const value = useMemo<UIStateContextValue>(
    () => ({
      currentView, setCurrentView,
      settingsInitialTab, setSettingsInitialTab,
      toasts, addToast, dismissToast, clearToasts,
      addModelDialogOpen, setAddModelDialogOpen,
      showChangelogDialog, closeChangelogDialog, openChangelogDialog,
      contextInfo, setContextInfo,
      draftInput, setDraftInput,
    }),
    [
      currentView, settingsInitialTab,
      toasts, addToast, dismissToast, clearToasts,
      addModelDialogOpen,
      showChangelogDialog, closeChangelogDialog, openChangelogDialog,
      contextInfo, draftInput,
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
