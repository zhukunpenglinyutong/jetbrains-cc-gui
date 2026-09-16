import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../types/provider';
import { ToastContainer } from '../Toast';

import SettingsHeader from './SettingsHeader';
import SettingsSidebar, { type SettingsTab } from './SettingsSidebar';
import type { ProviderManageTab } from './ProviderTabSection';
import SettingsContent from './SettingsContent';
import SettingsDialogsHost from './SettingsDialogsHost';
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
  initialProviderSubTab?: ProviderManageTab;
  currentProvider: 'claude' | 'codex' | string;
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  sendShortcut?: 'enter' | 'cmdEnter';
  onSendShortcutChange?: (shortcut: 'enter' | 'cmdEnter') => void;
  autoOpenFileEnabled?: boolean;
  onAutoOpenFileEnabledChange?: (enabled: boolean) => void;
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
  const disabledTabs = useMemo<SettingsTab[]>(() => [], []);
  const pageState = useSettingsPageState({ initialTab, isCodexMode, disabledTabs });
  const themeSync = useSettingsThemeSync();
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
  const providerManagement = useProviderManagement({
    onError: (msg) => pageState.showAlert('error', t('common.error'), msg),
    onSuccess: (msg) => pageState.addToast(msg, 'success'),
  });
  const codexProviderManagement = useCodexProviderManagement({
    onSuccess: (msg) => pageState.addToast(msg, 'success'),
  });
  const agentManagement = useAgentManagement({
    onSuccess: (msg) => pageState.addToast(msg, 'success'),
  });

  useLazyTabData(pageState.currentTab, {
    loadProviders: providerManagement.loadProviders,
    loadCodexProviders: codexProviderManagement.loadCodexProviders,
    loadAgents: agentManagement.loadAgents,
  });

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

  const handleSaveProviderFromDialog = useSaveProviderFromDialog({
    providerDialog: providerManagement.providerDialog,
    providers: providerManagement.providers,
    syncActiveProviderModelMapping: providerManagement.syncActiveProviderModelMapping,
    handleCloseProviderDialog: providerManagement.handleCloseProviderDialog,
    setLoading: providerManagement.setLoading,
    showAlert: pageState.showAlert,
    addToast: pageState.addToast,
  });
  const handleSaveCodexProviderFromDialog = (providerData: CodexProviderConfig) => {
    codexProviderManagement.handleSaveCodexProvider(providerData);
  };
  const handleSaveAgentFromDialog = (data: { name: string; prompt: string }) => {
    agentManagement.handleSaveAgent(data);
  };

  return (
    <div className={styles.settingsPage}>
      <SettingsHeader onClose={onClose} />
      <div className={styles.settingsMain}>
        <SettingsSidebar
          currentTab={pageState.currentTab}
          onTabChange={pageState.handleTabChange}
          isCollapsed={pageState.isCollapsed}
          onToggleCollapse={pageState.toggleManualCollapse}
          disabledTabs={disabledTabs}
          onDisabledTabClick={(tab) => pageState.addToast(
            t(tab === 'pet' ? 'settings.pet.temporarilyUnavailable' : 'settings.codexFeatureUnavailable'),
            'warning'
          )}
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
      <ToastContainer messages={pageState.toasts} onDismiss={pageState.dismissToast} />
    </div>
  );
};

export default SettingsView;
