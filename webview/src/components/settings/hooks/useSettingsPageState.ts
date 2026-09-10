// hooks/useSettingsPageState.ts
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsTab } from '../SettingsSidebar';
import type { AlertType } from '../../AlertDialog';
import type { ToastMessage } from '../../Toast';

// Auto-collapse threshold (window width)
export const AUTO_COLLAPSE_THRESHOLD = 900;

export interface UseSettingsPageStateReturn {
  currentTab: SettingsTab;
  toasts: ToastMessage[];
  windowWidth: number;
  manualCollapsed: boolean | null;
  alertDialog: {
    isOpen: boolean;
    type: AlertType;
    title: string;
    message: string;
  };
  isCollapsed: boolean;
  handleTabChange: (tab: SettingsTab) => void;
  toggleManualCollapse: () => void;
  showAlert: (type: AlertType, title: string, message: string) => void;
  closeAlert: () => void;
  addToast: (message: string, type?: ToastMessage['type']) => void;
  dismissToast: (id: string) => void;
}

interface UseSettingsPageStateProps {
  initialTab?: SettingsTab;
  isCodexMode: boolean;
  disabledTabs: SettingsTab[];
}

export function useSettingsPageState({
  initialTab,
  isCodexMode,
  disabledTabs,
}: UseSettingsPageStateProps): UseSettingsPageStateReturn {
  const { t } = useTranslation();

  const [currentTab, setCurrentTab] = useState<SettingsTab>(() => {
    const initial = initialTab || 'basic';
    if (isCodexMode && disabledTabs.includes(initial)) {
      return 'basic';
    }
    return initial;
  });

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);

  const [alertDialog, setAlertDialog] = useState<{
    isOpen: boolean;
    type: AlertType;
    title: string;
    message: string;
  }>({ isOpen: false, type: 'info', title: '', message: '' });

  // Determine whether to collapse: prefer manual setting, otherwise auto-detect based on window width
  const isCollapsed = manualCollapsed !== null ? manualCollapsed : windowWidth < AUTO_COLLAPSE_THRESHOLD;

  // Listen for window resize events
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);

      // If window resize should trigger auto-collapse state change, reset manual setting
      const shouldAutoCollapse = window.innerWidth < AUTO_COLLAPSE_THRESHOLD;
      if (manualCollapsed !== null && manualCollapsed === shouldAutoCollapse) {
        setManualCollapsed(null);
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [manualCollapsed]);

  // Sync tab when codex mode changes
  useEffect(() => {
    if (isCodexMode && disabledTabs.includes(currentTab)) {
      setCurrentTab('basic');
    }
  }, [isCodexMode, disabledTabs, currentTab]);

  const handleTabChange = useCallback(
    (tab: SettingsTab) => {
      if (isCodexMode && disabledTabs.includes(tab)) {
        setToasts((prev) => [
          ...prev,
          {
            id: `toast-${Date.now()}-${Math.random()}`,
            message: t('settings.codexFeatureUnavailable'),
            type: 'warning' as ToastMessage['type'],
          },
        ]);
        return;
      }
      setCurrentTab(tab);
    },
    [isCodexMode, disabledTabs, t]
  );

  const toggleManualCollapse = useCallback(() => {
    if (manualCollapsed === null) {
      // If currently in auto mode, switch to manual mode
      // isCollapsed reflects the current auto-state, so negate it
      const currentIsCollapsed = window.innerWidth < AUTO_COLLAPSE_THRESHOLD;
      setManualCollapsed(!currentIsCollapsed);
    } else {
      // If already in manual mode, toggle the state
      setManualCollapsed(!manualCollapsed);
    }
  }, [manualCollapsed]);

  const showAlert = useCallback((type: AlertType, title: string, message: string) => {
    setAlertDialog({ isOpen: true, type, title, message });
  }, []);

  const closeAlert = useCallback(() => {
    setAlertDialog((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return {
    currentTab,
    toasts,
    windowWidth,
    manualCollapsed,
    alertDialog,
    isCollapsed,
    handleTabChange,
    toggleManualCollapse,
    showAlert,
    closeAlert,
    addToast,
    dismissToast,
  };
}
