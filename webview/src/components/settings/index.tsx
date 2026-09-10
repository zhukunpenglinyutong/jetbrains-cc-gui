import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../types/provider';
import { ToastContainer } from '../Toast';

// Import split-out components
import SettingsHeader from './SettingsHeader';
import SettingsSidebar, { type SettingsTab } from './SettingsSidebar';
import type { ProviderManageTab } from './ProviderTabSection';
import SettingsContent from './SettingsContent';
import SettingsDialogsHost from './SettingsDialogsHost';

// Import custom hooks
import {
  useProviderManagement,
  useCodexProviderManagement,
  useAgentManagement,
  useSettingsWindowCallbacks,
  useSettingsPageState,
  useSettingsThemeSync,
  useSettingsBasicActions,
} from './hooks';
import { useLazyTabData } from './hooks/useLazyTabData';
import { useSaveProviderFromDialog } from './hooks/useSaveProviderFromDialog';

import styles from './style.module.less';

interface SettingsViewProps {
  onClose: () => void;
  initialTab?: SettingsTab;
  /** Deep link into the Providers tab's sub-tab (claude/codex/cli) */
  initialProviderSubTab?: ProviderManageTab;
  currentProvider: 'claude' | 'codex' | string;
  // Streaming configuration (passed from App.tsx for state sync)
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  // Send shortcut configuration (passed from App.tsx for state sync)
  sendShortcut?: 'enter' | 'cmdEnter';
  onSendShortcutChange?: (shortcut: 'enter' | 'cmdEnter') => void;
  // Auto open file configuration (passed from App.tsx for state sync)
  autoOpenFileEnabled?: boolean;
  onAutoOpenFileEnabledChange?: (enabled: boolean) => void;
  // Permission dialog timeout configuration (passed from App.tsx for state sync)
  permissionDialogTimeoutSeconds?: number;
  onPermissionDialogTimeoutChange?: (seconds: number) => void;
}

const SettingsView = ({
  onClose,
  initialTab,
  initialProviderSubTab,
  currentProvider,
  streamingEnabled: streamingEnabledProp,
  onStreamingEnabledChange: onStreamingEnabledChangeProp,
  sendShortcut: sendShortcutProp,
  onSendShortcutChange: onSendShortcutChangeProp,
  autoOpenFileEnabled: autoOpenFileEnabledProp,
  onAutoOpenFileEnabledChange: onAutoOpenFileEnabledChangeProp,
  permissionDialogTimeoutSeconds: permissionDialogTimeoutSecondsProp,
  onPermissionDialogTimeoutChange: onPermissionDialogTimeoutChangeProp,
}: SettingsViewProps) => {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';
  // Codex mode: align with Claude capabilities for settings tabs.
  // Keep the Codex pet settings available.
  const disabledTabs = useMemo<SettingsTab[]>(
    () => [],
    []
  );

  // Page state: tabs, toasts, sidebar collapse, alert dialog
  const pageState = useSettingsPageState({ initialTab, isCodexMode, disabledTabs });

  // Theme sync: theme preference, IDE theme, font size, chat colors
  const themeSync = useSettingsThemeSync();

  // Basic settings actions: node path, working dir, streaming, shortcuts, sound, commit prompt, etc.
  const basicActions = useSettingsBasicActions({
    streamingEnabledProp,
    onStreamingEnabledChangeProp,
    sendShortcutProp,
    onSendShortcutChangeProp,
    autoOpenFileEnabledProp,
    onAutoOpenFileEnabledChangeProp,
    permissionDialogTimeoutSecondsProp,
    onPermissionDialogTimeoutChangeProp,
    currentProvider,
  });

  // Use provider management hook
  const providerManagement = useProviderManagement({
    onError: (msg) => pageState.showAlert('error', t('common.error'), msg),
    onSuccess: (msg) => pageState.addToast(msg, 'success'),
  });

  // Use Codex provider management hook
  const codexProviderManagement = useCodexProviderManagement({
    onSuccess: (msg) => pageState.addToast(msg, 'success'),
  });

  // Use agent management hook
  const agentManagement = useAgentManagement({
    onSuccess: (msg) => pageState.addToast(msg, 'success'),
  });

  // Note: Prompt management is now handled internally by PromptSection component

  useLazyTabData(pageState.currentTab, {
    loadProviders: providerManagement.loadProviders,
    loadCodexProviders: codexProviderManagement.loadCodexProviders,
    loadAgents: agentManagement.loadAgents,
  });

  // Register window callbacks for Java bridge communication
  useSettingsWindowCallbacks({
    ...themeSync,
    ...basicActions,
    ...pageState,
    ...providerManagement,
    ...codexProviderManagement,
    ...agentManagement,
    onStreamingEnabledChangeProp,
    onSendShortcutChangeProp,
  });

  // Save provider (wrapper function with validation logic)
  const handleSaveProviderFromDialog = useSaveProviderFromDialog({
    providerDialog: providerManagement.providerDialog,
    providers: providerManagement.providers,
    syncActiveProviderModelMapping: providerManagement.syncActiveProviderModelMapping,
    handleCloseProviderDialog: providerManagement.handleCloseProviderDialog,
    setLoading: providerManagement.setLoading,
    showAlert: pageState.showAlert,
    addToast: pageState.addToast,
  });

  // Save Codex provider (wrapper function with validation logic)
  const handleSaveCodexProviderFromDialog = (providerData: CodexProviderConfig) => {
    codexProviderManagement.handleSaveCodexProvider(providerData);
  };

  // Save agent (wrapper function with validation logic)
  const handleSaveAgentFromDialog = (data: { name: string; prompt: string }) => {
    agentManagement.handleSaveAgent(data);
  };

  return (
    <div className={styles.settingsPage}>
      {/* Top header bar */}
      <SettingsHeader onClose={onClose} />

      {/* Main content */}
      <div className={styles.settingsMain}>
        {/* Sidebar */}
        <SettingsSidebar
          currentTab={pageState.currentTab}
          onTabChange={pageState.handleTabChange}
          isCollapsed={pageState.isCollapsed}
          onToggleCollapse={pageState.toggleManualCollapse}
          disabledTabs={disabledTabs}
          onDisabledTabClick={(tab) =>
            pageState.addToast(
              t(tab === 'pet' ? 'settings.pet.temporarilyUnavailable' : 'settings.codexFeatureUnavailable'),
              'warning'
            )
          }
        />

        <SettingsContent
          currentTab={pageState.currentTab}
          currentProvider={currentProvider}
          initialProviderSubTab={initialProviderSubTab}
          addToast={pageState.addToast}
          themeSync={themeSync}
          basicActions={basicActions}
          providerManagement={providerManagement}
          codexProviderManagement={codexProviderManagement}
          agentManagement={agentManagement}
        />
      </div>

      <SettingsDialogsHost
        pageState={pageState}
        providerManagement={providerManagement}
        codexProviderManagement={codexProviderManagement}
        agentManagement={agentManagement}
        onSaveProvider={handleSaveProviderFromDialog}
        onSaveCodexProvider={handleSaveCodexProviderFromDialog}
        onSaveAgent={handleSaveAgentFromDialog}
      />

      {/* Toast notifications */}
      <ToastContainer messages={pageState.toasts} onDismiss={pageState.dismissToast} />
    </div>
  );
};

export default SettingsView;
