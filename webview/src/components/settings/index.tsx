import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../types/provider';
import { ToastContainer } from '../Toast';

// Import split-out components
import SettingsHeader from './SettingsHeader';
import SettingsSidebar, { type SettingsTab } from './SettingsSidebar';
import BasicConfigSection from './BasicConfigSection';
import ProviderTabSection from './ProviderTabSection';
import DependencySection from './DependencySection';
import UsageSection from './UsageSection';
import PlaceholderSection from './PlaceholderSection';
import PermissionsSection from './PermissionsSection';
import CommunitySection from './CommunitySection';
import AgentSection from './AgentSection';
import PromptSection from './PromptSection';
import CommitSection from './CommitSection';
import PromptEnhancerSection from './PromptEnhancerSection';
import OtherSettingsSection from './OtherSettingsSection';
import { SkillsSettingsSection } from '../skills';
import SettingsDialogs from './SettingsDialogs';

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

import styles from './style.module.less';

interface SettingsViewProps {
  onClose: () => void;
  initialTab?: SettingsTab;
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
}

const SettingsView = ({
  onClose,
  initialTab,
  currentProvider,
  streamingEnabled: streamingEnabledProp,
  onStreamingEnabledChange: onStreamingEnabledChangeProp,
  sendShortcut: sendShortcutProp,
  onSendShortcutChange: onSendShortcutChangeProp,
  autoOpenFileEnabled: autoOpenFileEnabledProp,
  onAutoOpenFileEnabledChange: onAutoOpenFileEnabledChangeProp
}: SettingsViewProps) => {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';
  // Codex mode: align with Claude capabilities for settings tabs
  const disabledTabs = useMemo<SettingsTab[]>(
    () => [],
    [isCodexMode]
  );

  // Page state: tabs, toasts, sidebar collapse, alert dialog
  const {
    currentTab,
    toasts,
    alertDialog,
    isCollapsed,
    handleTabChange,
    toggleManualCollapse,
    showAlert,
    closeAlert,
    addToast,
    dismissToast,
  } = useSettingsPageState({ initialTab, isCodexMode, disabledTabs });

  // Theme sync: theme preference, IDE theme, font size, chat colors
  const {
    themePreference,
    setThemePreference,
    setIdeTheme,
    fontSizeLevel,
    setFontSizeLevel,
    chatBgColor,
    setChatBgColor,
    userMsgColor,
    setUserMsgColor,
    diffTheme,
    setDiffTheme,
  } = useSettingsThemeSync();

  // Basic settings actions: node path, working dir, streaming, shortcuts, sound, commit prompt, etc.
  const {
    nodePath,
    setNodePath,
    nodeVersion,
    setNodeVersion,
    minNodeVersion,
    setMinNodeVersion,
    savingNodePath,
    setSavingNodePath,
    workingDirectory,
    setWorkingDirectory,
    savingWorkingDirectory,
    setSavingWorkingDirectory,
    editorFontConfig,
    setEditorFontConfig,
    uiFontConfig,
    setUiFontConfig,
    setLocalStreamingEnabled,
    streamingEnabled,
    codexSandboxMode,
    setCodexSandboxMode,
    setLocalSendShortcut,
    sendShortcut,
    autoOpenFileEnabled,
    promptEnhancerConfig,
    setPromptEnhancerConfig,
    commitPrompt,
    setCommitPrompt,
    savingCommitPrompt,
    setSavingCommitPrompt,
    soundNotificationEnabled,
    setSoundNotificationEnabled,
    soundOnlyWhenUnfocused,
    setSoundOnlyWhenUnfocused,
    selectedSound,
    setSelectedSound,
    customSoundPath,
    setCustomSoundPath,
    diffExpandedByDefault,
    setDiffExpandedByDefault,
    historyCompletionEnabled,
    setHistoryCompletionEnabled,
    handleSaveNodePath,
    handleSaveWorkingDirectory,
    handleUiFontSelectionChange,
    handleSaveUiFontCustomPath,
    handleBrowseUiFontFile,
    handleStreamingEnabledChange,
    handleCodexSandboxModeChange,
    handleSendShortcutChange,
    handleAutoOpenFileEnabledChange,
    handleSoundNotificationEnabledChange,
    handleSoundOnlyWhenUnfocusedChange,
    handleSelectedSoundChange,
    handleCustomSoundPathChange,
    handleSaveCustomSoundPath,
    handleTestSound,
    handleBrowseSound,
    handleSaveCommitPrompt,
    commitGenerationEnabled,
    setCommitGenerationEnabled,
    handleCommitGenerationEnabledChange,
    statusBarWidgetEnabled,
    setStatusBarWidgetEnabled,
    handleStatusBarWidgetEnabledChange,
    commitAiConfig,
    setCommitAiConfig,
    handleCommitAiProviderChange,
    handleCommitAiModelChange,
    handleCommitAiResetToDefault,
    handlePromptEnhancerProviderChange,
    handlePromptEnhancerModelChange,
    handlePromptEnhancerResetToDefault,
  } = useSettingsBasicActions({
    streamingEnabledProp,
    onStreamingEnabledChangeProp,
    sendShortcutProp,
    onSendShortcutChangeProp,
    autoOpenFileEnabledProp,
    onAutoOpenFileEnabledChangeProp,
  });

  // Use provider management hook
  const {
    providers,
    loading,
    providerDialog,
    deleteConfirm,
    loadProviders,
    updateProviders,
    updateActiveProvider,
    handleEditProvider,
    handleAddProvider,
    handleCloseProviderDialog,
    handleSwitchProvider,
    handleDeleteProvider,
    confirmDeleteProvider,
    cancelDeleteProvider,
    syncActiveProviderModelMapping,
    setLoading,
  } = useProviderManagement({
    onError: (msg) => showAlert('error', t('common.error'), msg),
    onSuccess: (msg) => addToast(msg, 'success'),
  });

  // Use Codex provider management hook
  const {
    codexProviders,
    codexLoading,
    codexProviderDialog,
    deleteCodexConfirm,
    loadCodexProviders,
    updateCodexProviders,
    updateActiveCodexProvider,
    updateCurrentCodexConfig,
    handleAddCodexProvider,
    handleEditCodexProvider,
    handleCloseCodexProviderDialog,
    handleSaveCodexProvider,
    handleSwitchCodexProvider,
    handleRevokeCodexLocalConfigAuthorization,
    handleDeleteCodexProvider,
    confirmDeleteCodexProvider,
    cancelDeleteCodexProvider,
    setCodexLoading,
    setCodexConfigLoading,
  } = useCodexProviderManagement({
    onSuccess: (msg) => addToast(msg, 'success'),
  });

  // Use agent management hook
  const {
    agents,
    agentsLoading,
    agentDialog,
    deleteAgentConfirm,
    importPreviewDialog: agentImportPreviewDialog,
    exportDialog: agentExportDialog,
    loadAgents,
    updateAgents,
    cleanupAgentsTimeout,
    handleAddAgent,
    handleEditAgent,
    handleCloseAgentDialog,
    handleDeleteAgent,
    handleSaveAgent,
    confirmDeleteAgent,
    cancelDeleteAgent,
    handleAgentOperationResult,
    handleExportAgents,
    handleCloseExportDialog: handleCloseAgentExportDialog,
    handleConfirmExport: handleConfirmAgentExport,
    handleImportAgentsFile,
    handleAgentImportPreviewResult,
    handleCloseImportPreview: handleCloseAgentImportPreview,
    handleSaveImportedAgents,
    handleAgentImportResult,
  } = useAgentManagement({
    onSuccess: (msg) => addToast(msg, 'success'),
  });

  // Note: Prompt management is now handled internally by PromptSection component

  // Register window callbacks for Java bridge communication
  useSettingsWindowCallbacks({
    setNodePath,
    setNodeVersion,
    setMinNodeVersion,
    setSavingNodePath,
    setWorkingDirectory,
    setSavingWorkingDirectory,
    setCommitPrompt,
    setSavingCommitPrompt,
    setCommitAiConfig,
    setPromptEnhancerConfig,
    setEditorFontConfig,
    setUiFontConfig,
    setIdeTheme,
    setLocalStreamingEnabled,
    setCodexSandboxMode,
    setLocalSendShortcut,
    setLoading,
    setCodexLoading,
    setCodexConfigLoading,
    updateProviders,
    updateActiveProvider,
    loadProviders,
    loadCodexProviders,
    loadAgents,
    updateAgents,
    handleAgentOperationResult,
    handleAgentImportPreviewResult,
    handleAgentImportResult,
    // Note: Prompt-related callbacks are now handled in PromptSection component
    updateCodexProviders,
    updateActiveCodexProvider,
    updateCurrentCodexConfig,
    cleanupAgentsTimeout,
    showAlert,
    addToast,
    onStreamingEnabledChangeProp,
    onSendShortcutChangeProp,
    setSoundNotificationEnabled,
    setSoundOnlyWhenUnfocused,
    setSelectedSound,
    setCustomSoundPath,
    setCommitGenerationEnabled,
    setStatusBarWidgetEnabled,
  });

  // Save provider (wrapper function with validation logic)
  const handleSaveProviderFromDialog = (data: {
    providerName: string;
    remark: string;
    apiKey: string;
    apiUrl: string;
    jsonConfig: string;
  }) => {
    if (!data.providerName) {
      showAlert('warning', t('common.warning'), t('toast.pleaseEnterProviderName'));
      return;
    }

    // Parse JSON configuration
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(data.jsonConfig || '{}');
    } catch (e) {
      showAlert('error', t('common.error'), t('toast.invalidJsonConfig'));
      return;
    }

    const updates: Record<string, any> = {
      name: data.providerName,
      remark: data.remark,
      websiteUrl: null, // Clear potentially existing legacy field to avoid display confusion
      settingsConfig: parsedConfig,
    };

    const isAdding = !providerDialog.provider;

    if (isAdding) {
      // Add new provider
      const newProvider = {
        id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
        ...updates
      };
      window.sendToJava?.(`add_provider:${JSON.stringify(newProvider)}`);
      addToast(t('toast.providerAdded'), 'success');
    } else {
      // Update existing provider
      if (!providerDialog.provider) return;

      const providerId = providerDialog.provider.id;
      // Check if the currently edited provider is active
      // Prefer the latest state from providers list; fall back to dialog state if not found
      const currentProviderItem = providers.find(p => p.id === providerId) || providerDialog.provider;
      const isActive = currentProviderItem.isActive;

      const updateData = {
        id: providerId,
        updates,
      };
      window.sendToJava?.(`update_provider:${JSON.stringify(updateData)}`);
      addToast(t('toast.providerUpdated'), 'success');

      // If this is the currently active provider, immediately re-apply the configuration after update
      if (isActive) {
        syncActiveProviderModelMapping({
          ...currentProviderItem,
          settingsConfig: parsedConfig,
        });
        // Use setTimeout for a slight delay to ensure update_provider finishes first
        setTimeout(() => {
          window.sendToJava?.(`switch_provider:${JSON.stringify({ id: providerId })}`);
        }, 100);
      }
    }

    handleCloseProviderDialog();
    setLoading(true);
  };

  // Save Codex provider (wrapper function with validation logic)
  const handleSaveCodexProviderFromDialog = (providerData: CodexProviderConfig) => {
    handleSaveCodexProvider(providerData);
  };

  // Save agent (wrapper function with validation logic)
  const handleSaveAgentFromDialog = (data: { name: string; prompt: string }) => {
    handleSaveAgent(data);
  };

  return (
    <div className={styles.settingsPage}>
      {/* Top header bar */}
      <SettingsHeader onClose={onClose} />

      {/* Main content */}
      <div className={styles.settingsMain}>
        {/* Sidebar */}
        <SettingsSidebar
          currentTab={currentTab}
          onTabChange={handleTabChange}
          isCollapsed={isCollapsed}
          onToggleCollapse={toggleManualCollapse}
          disabledTabs={disabledTabs}
          onDisabledTabClick={() => addToast(t('settings.codexFeatureUnavailable'), 'warning')}
        />

        {/* Content area */}
        <div className={`${styles.settingsContent} ${currentTab === 'providers' ? styles.providerSettingsContent : ''}`}>
          {/* Basic configuration */}
          <div style={{ display: currentTab === 'basic' ? 'block' : 'none' }}>
            <BasicConfigSection
              theme={themePreference}
              onThemeChange={setThemePreference}
              fontSizeLevel={fontSizeLevel}
              onFontSizeLevelChange={setFontSizeLevel}
              nodePath={nodePath}
              onNodePathChange={setNodePath}
              onSaveNodePath={handleSaveNodePath}
              savingNodePath={savingNodePath}
              nodeVersion={nodeVersion}
              minNodeVersion={minNodeVersion}
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={setWorkingDirectory}
              onSaveWorkingDirectory={handleSaveWorkingDirectory}
              savingWorkingDirectory={savingWorkingDirectory}
              editorFontConfig={editorFontConfig}
              uiFontConfig={uiFontConfig}
              onUiFontSelectionChange={handleUiFontSelectionChange}
              onSaveUiFontCustomPath={handleSaveUiFontCustomPath}
              onBrowseUiFontFile={handleBrowseUiFontFile}
              streamingEnabled={streamingEnabled}
              onStreamingEnabledChange={handleStreamingEnabledChange}
              sendShortcut={sendShortcut}
              onSendShortcutChange={handleSendShortcutChange}
              autoOpenFileEnabled={autoOpenFileEnabled}
              onAutoOpenFileEnabledChange={handleAutoOpenFileEnabledChange}
              chatBgColor={chatBgColor}
              onChatBgColorChange={setChatBgColor}
              userMsgColor={userMsgColor}
              onUserMsgColorChange={setUserMsgColor}
              diffTheme={diffTheme}
              onDiffThemeChange={setDiffTheme}
              diffExpandedByDefault={diffExpandedByDefault}
              onDiffExpandedByDefaultChange={setDiffExpandedByDefault}
              commitGenerationEnabled={commitGenerationEnabled}
              onCommitGenerationEnabledChange={(enabled) => {
                handleCommitGenerationEnabledChange(enabled);
                addToast(t('toast.restartRequired'), 'warning');
              }}
              statusBarWidgetEnabled={statusBarWidgetEnabled}
              onStatusBarWidgetEnabledChange={(enabled) => {
                handleStatusBarWidgetEnabledChange(enabled);
                addToast(t('toast.restartRequired'), 'warning');
              }}
              soundNotificationEnabled={soundNotificationEnabled}
              onSoundNotificationEnabledChange={handleSoundNotificationEnabledChange}
              soundOnlyWhenUnfocused={soundOnlyWhenUnfocused}
              onSoundOnlyWhenUnfocusedChange={handleSoundOnlyWhenUnfocusedChange}
              selectedSound={selectedSound}
              onSelectedSoundChange={handleSelectedSoundChange}
              customSoundPath={customSoundPath}
              onCustomSoundPathChange={handleCustomSoundPathChange}
              onSaveCustomSoundPath={handleSaveCustomSoundPath}
              onTestSound={handleTestSound}
              onBrowseSound={handleBrowseSound}
            />
          </div>

          {/* Provider management (Claude + Codex internal tab switching) */}
          <div style={{ display: currentTab === 'providers' ? 'block' : 'none' }}>
            <ProviderTabSection
              currentProvider={currentProvider}
              providers={providers}
              loading={loading}
              onAddProvider={handleAddProvider}
              onEditProvider={handleEditProvider}
              onDeleteProvider={handleDeleteProvider}
              onSwitchProvider={handleSwitchProvider}
              codexProviders={codexProviders}
              codexLoading={codexLoading}
              onAddCodexProvider={handleAddCodexProvider}
                onEditCodexProvider={handleEditCodexProvider}
                onDeleteCodexProvider={handleDeleteCodexProvider}
                onSwitchCodexProvider={handleSwitchCodexProvider}
                onRevokeCodexLocalConfigAuthorization={handleRevokeCodexLocalConfigAuthorization}
                addToast={addToast}
              />
          </div>

          {/* SDK dependency management */}
          <div style={{ display: currentTab === 'dependencies' ? 'block' : 'none' }}>
            <DependencySection addToast={addToast} isActive={currentTab === 'dependencies'} />
          </div>

          {/* Usage statistics */}
          <div style={{ display: currentTab === 'usage' ? 'block' : 'none' }}>
            <UsageSection currentProvider={currentProvider} />
          </div>

          {/* MCP servers */}
          <div style={{ display: currentTab === 'mcp' ? 'block' : 'none' }}>
            <PlaceholderSection type="mcp" currentProvider={currentProvider} />
          </div>

          {/* Permissions configuration */}
          <div style={{ display: currentTab === 'permissions' ? 'block' : 'none' }}>
            {currentProvider === 'codex' ? (
              <PermissionsSection
                codexSandboxMode={codexSandboxMode}
                onCodexSandboxModeChange={handleCodexSandboxModeChange}
              />
            ) : (
              <PlaceholderSection type="permissions" />
            )}
          </div>

          {/* Prompt enhancer configuration */}
          <div style={{ display: currentTab === 'promptEnhancer' ? 'block' : 'none' }}>
            <PromptEnhancerSection
              promptEnhancerConfig={promptEnhancerConfig}
              onPromptEnhancerProviderChange={handlePromptEnhancerProviderChange}
              onPromptEnhancerModelChange={handlePromptEnhancerModelChange}
              onPromptEnhancerResetToDefault={handlePromptEnhancerResetToDefault}
            />
          </div>

          {/* Commit AI configuration */}
          <div style={{ display: currentTab === 'commit' ? 'block' : 'none' }}>
            <CommitSection
              commitAiConfig={commitAiConfig}
              onCommitAiProviderChange={handleCommitAiProviderChange}
              onCommitAiModelChange={handleCommitAiModelChange}
              onCommitAiResetToDefault={handleCommitAiResetToDefault}
              commitPrompt={commitPrompt}
              onCommitPromptChange={setCommitPrompt}
              onSaveCommitPrompt={handleSaveCommitPrompt}
              savingCommitPrompt={savingCommitPrompt}
            />
          </div>

          {/* Agents */}
          <div style={{ display: currentTab === 'agents' ? 'block' : 'none' }}>
            <AgentSection
              agents={agents}
              loading={agentsLoading}
              onAdd={handleAddAgent}
              onEdit={handleEditAgent}
              onDelete={handleDeleteAgent}
              onExport={handleExportAgents}
              onImport={handleImportAgentsFile}
            />
          </div>

          {/* Prompts */}
          <div style={{ display: currentTab === 'prompts' ? 'block' : 'none' }}>
            <PromptSection
              onSuccess={(msg) => addToast(msg, 'success')}
            />
          </div>

          {/* Skills */}
          <div style={{ display: currentTab === 'skills' ? 'block' : 'none' }}>
            <SkillsSettingsSection currentProvider={currentProvider} />
          </div>

          {/* Other settings */}
          <div style={{ display: currentTab === 'other' ? 'block' : 'none' }}>
            <OtherSettingsSection
              historyCompletionEnabled={historyCompletionEnabled}
              onHistoryCompletionEnabledChange={(enabled) => {
                setHistoryCompletionEnabled(enabled);
                localStorage.setItem('historyCompletionEnabled', enabled.toString());
                // Dispatch custom event for same-tab sync (localStorage 'storage' event only fires for cross-tab)
                window.dispatchEvent(new CustomEvent('historyCompletionChanged', { detail: { enabled } }));
              }}
            />
          </div>

          {/* Community */}
          <div style={{ display: currentTab === 'community' ? 'block' : 'none' }}>
            <CommunitySection addToast={addToast} />
          </div>
        </div>
      </div>

      {/* All dialogs (alert, confirm, provider, agent, prompt, codex) */}
      <SettingsDialogs
        alertDialog={alertDialog}
        onCloseAlert={closeAlert}
        providerDialog={providerDialog}
        deleteConfirm={deleteConfirm}
        onCloseProviderDialog={handleCloseProviderDialog}
        onSaveProvider={handleSaveProviderFromDialog}
        onDeleteProvider={handleDeleteProvider}
        onConfirmDeleteProvider={confirmDeleteProvider}
        onCancelDeleteProvider={cancelDeleteProvider}
        codexProviderDialog={codexProviderDialog}
        deleteCodexConfirm={deleteCodexConfirm}
        onCloseCodexProviderDialog={handleCloseCodexProviderDialog}
        onSaveCodexProvider={handleSaveCodexProviderFromDialog}
        onConfirmDeleteCodexProvider={confirmDeleteCodexProvider}
        onCancelDeleteCodexProvider={cancelDeleteCodexProvider}
        agentDialog={agentDialog}
        deleteAgentConfirm={deleteAgentConfirm}
        onCloseAgentDialog={handleCloseAgentDialog}
        onSaveAgent={handleSaveAgentFromDialog}
        onConfirmDeleteAgent={confirmDeleteAgent}
        onCancelDeleteAgent={cancelDeleteAgent}
        agentExportDialog={agentExportDialog}
        agentImportPreviewDialog={agentImportPreviewDialog}
        agents={agents}
        onCloseAgentExportDialog={handleCloseAgentExportDialog}
        onConfirmAgentExport={handleConfirmAgentExport}
        onCloseAgentImportPreview={handleCloseAgentImportPreview}
        onSaveImportedAgents={handleSaveImportedAgents}
        addToast={addToast}
      />

      {/* Toast notifications */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
};

export default SettingsView;
