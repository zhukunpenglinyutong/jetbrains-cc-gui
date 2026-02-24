import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../types/provider';
import { type ClaudeConfig } from './ConfigInfoDisplay';
import type { AlertType } from '../AlertDialog';
import { ToastContainer, type ToastMessage } from '../Toast';

// Import split-out components
import SettingsHeader from './SettingsHeader';
import SettingsSidebar, { type SettingsTab } from './SettingsSidebar';
import BasicConfigSection from './BasicConfigSection';
import ProviderTabSection from './ProviderTabSection';
import DependencySection from './DependencySection';
import UsageSection from './UsageSection';
import PlaceholderSection from './PlaceholderSection';
import CommunitySection from './CommunitySection';
import AgentSection from './AgentSection';
import PromptSection from './PromptSection';
import CommitSection from './CommitSection';
import OtherSettingsSection from './OtherSettingsSection';
import { SkillsSettingsSection } from '../skills';
import SettingsDialogs from './SettingsDialogs';

// Import custom hooks
import {
  useProviderManagement,
  useCodexProviderManagement,
  useAgentManagement,
  usePromptManagement,
  useSettingsWindowCallbacks,
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

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  } else {
    console.warn('[SettingsView] sendToJava is not available');
  }
};

// Auto-collapse threshold (window width)
const AUTO_COLLAPSE_THRESHOLD = 900;

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
  // Codex mode: allow providers, usage, and mcp tabs, disable other features
  // Note: 'mcp' is now enabled for Codex as it supports MCP via ~/.codex/config.toml
  const disabledTabs = useMemo<SettingsTab[]>(
    () => (isCodexMode ? ['permissions', 'agents', 'skills'] : []),
    [isCodexMode]
  );
  const [currentTab, setCurrentTab] = useState<SettingsTab>(() => {
    const initial = initialTab || 'basic';
    if (isCodexMode && disabledTabs.includes(initial)) {
      return 'basic';
    }
    return initial;
  });

  // Toast state management
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Toast helper function
  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

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

  // Use prompt management hook
  const {
    prompts,
    promptsLoading,
    promptDialog,
    deletePromptConfirm,
    importPreviewDialog: promptImportPreviewDialog,
    exportDialog: promptExportDialog,
    loadPrompts,
    updatePrompts,
    cleanupPromptsTimeout,
    handleAddPrompt,
    handleEditPrompt,
    handleClosePromptDialog,
    handleDeletePrompt,
    handleSavePrompt,
    confirmDeletePrompt,
    cancelDeletePrompt,
    handlePromptOperationResult,
    handleExportPrompts,
    handleCloseExportDialog: handleClosePromptExportDialog,
    handleConfirmExport: handleConfirmPromptExport,
    handleImportPromptsFile,
    handlePromptImportPreviewResult,
    handleCloseImportPreview: handleClosePromptImportPreview,
    handleSaveImportedPrompts,
    handlePromptImportResult,
  } = usePromptManagement({
    onSuccess: (msg) => addToast(msg, 'success'),
  });

  // Current Claude CLI configuration (from ~/.claude/settings.json)
  const [claudeConfig, setClaudeConfig] = useState<ClaudeConfig | null>(null);
  const [claudeConfigLoading, setClaudeConfigLoading] = useState(false);

  // Sidebar responsive state
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);

  // Determine whether to collapse: prefer manual setting, otherwise auto-detect based on window width
  const isCollapsed = manualCollapsed !== null
      ? manualCollapsed
      : windowWidth < AUTO_COLLAPSE_THRESHOLD;

  // In-page alert dialog state
  const [alertDialog, setAlertDialog] = useState<{
    isOpen: boolean;
    type: AlertType;
    title: string;
    message: string;
  }>({ isOpen: false, type: 'info', title: '', message: '' });

  // Theme state
  const [themePreference, setThemePreference] = useState<'light' | 'dark' | 'system'>(() => {
    // Read theme preference from localStorage
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      return savedTheme;
    }
    return 'system'; // Default: follow IDE
  });

  // IDE theme state (prefer Java-injected initial theme, used to handle dynamic changes)
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    // Check if Java has injected the initial theme
    const injectedTheme = (window as any).__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });

  // Font size level state (1-6, default is 2, i.e. 90%)
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(() => {
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 2;
    return level >= 1 && level <= 6 ? level : 2;
  });

  // Node.js path (used when manually specified)
  const [nodePath, setNodePath] = useState('');
  const [nodeVersion, setNodeVersion] = useState<string | null>(null);
  const [minNodeVersion, setMinNodeVersion] = useState(18);
  const [savingNodePath, setSavingNodePath] = useState(false);

  // Working directory configuration
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [savingWorkingDirectory, setSavingWorkingDirectory] = useState(false);

  // IDEA editor font configuration (read-only display)
  const [editorFontConfig, setEditorFontConfig] = useState<{
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
  } | undefined>();

  // Streaming configuration - prefer props, fallback to local state (for backward compatibility when props are not passed)
  const [localStreamingEnabled, setLocalStreamingEnabled] = useState<boolean>(false);
  const streamingEnabled = streamingEnabledProp ?? localStreamingEnabled;

  // Send shortcut configuration - prefer props, fallback to local state
  const [localSendShortcut, setLocalSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');
  const sendShortcut = sendShortcutProp ?? localSendShortcut;

  // Auto open file configuration - prefer props, fallback to local state
  const [localAutoOpenFileEnabled, setLocalAutoOpenFileEnabled] = useState<boolean>(true);
  const autoOpenFileEnabled = autoOpenFileEnabledProp ?? localAutoOpenFileEnabled;

  // Commit AI prompt configuration
  const [commitPrompt, setCommitPrompt] = useState('');
  const [savingCommitPrompt, setSavingCommitPrompt] = useState(false);

  // Chat background color configuration
  const [chatBgColor, setChatBgColor] = useState<string>(() => {
    const saved = localStorage.getItem('chatBgColor');
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) {
      return saved;
    }
    return '';
  });

  // History completion toggle configuration
  const [historyCompletionEnabled, setHistoryCompletionEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('historyCompletionEnabled');
    return saved !== 'false'; // Enabled by default
  });

  // Diff expanded by default configuration (localStorage-only)
  const [diffExpandedByDefault, setDiffExpandedByDefault] = useState<boolean>(() => {
    try {
      return localStorage.getItem('diffExpandedByDefault') === 'true';
    } catch {
      return false;
    }
  });

  const handleTabChange = (tab: SettingsTab) => {
    if (isCodexMode && disabledTabs.includes(tab)) {
      addToast(t('settings.codexFeatureUnavailable'), 'warning');
      return;
    }
    setCurrentTab(tab);
  };

  // Helper function to show in-page alert dialog
  const showAlert = (type: AlertType, title: string, message: string) => {
    console.log('[SettingsView] showAlert called:', { type, title, message });
    setAlertDialog({ isOpen: true, type, title, message });
  };

  const closeAlert = () => {
    setAlertDialog({ ...alertDialog, isOpen: false });
  };

  // Register window callbacks for Java bridge communication
  useSettingsWindowCallbacks({
    setClaudeConfig,
    setClaudeConfigLoading,
    setNodePath,
    setNodeVersion,
    setMinNodeVersion,
    setSavingNodePath,
    setWorkingDirectory,
    setSavingWorkingDirectory,
    setCommitPrompt,
    setSavingCommitPrompt,
    setEditorFontConfig,
    setIdeTheme,
    setLocalStreamingEnabled,
    setLocalSendShortcut,
    setLoading,
    setCodexLoading,
    setCodexConfigLoading,
    updateProviders,
    updateActiveProvider,
    loadProviders,
    loadCodexProviders,
    loadAgents,
    loadPrompts,
    updateAgents,
    handleAgentOperationResult,
    handleAgentImportPreviewResult,
    handleAgentImportResult,
    updatePrompts,
    handlePromptOperationResult,
    handlePromptImportPreviewResult,
    handlePromptImportResult,
    updateCodexProviders,
    updateActiveCodexProvider,
    updateCurrentCodexConfig,
    cleanupAgentsTimeout,
    cleanupPromptsTimeout,
    showAlert,
    addToast,
    onStreamingEnabledChangeProp,
    onSendShortcutChangeProp,
  });

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

  // Manually toggle sidebar collapse state
  const toggleManualCollapse = () => {
    if (manualCollapsed === null) {
      // If currently in auto mode, switch to manual mode
      setManualCollapsed(!isCollapsed);
    } else {
      // If already in manual mode, toggle the state
      setManualCollapsed(!manualCollapsed);
    }
  };

  // Theme switching handler (supports following IDE theme)
  useEffect(() => {
    const applyTheme = (preference: 'light' | 'dark' | 'system') => {
      if (preference === 'system') {
        // If following IDE, need to wait for IDE theme to load
        if (ideTheme === null) {
          console.log('[SettingsView] Waiting for IDE theme to load...');
          return; // Wait for ideTheme to load
        }
        document.documentElement.setAttribute('data-theme', ideTheme);
      } else {
        // Explicit light/dark selection, apply immediately
        document.documentElement.setAttribute('data-theme', preference);
      }
    };

    applyTheme(themePreference);
    // Save to localStorage
    localStorage.setItem('theme', themePreference);
  }, [themePreference, ideTheme]);

  // Font size scaling handler
  useEffect(() => {
    // Map level to scale ratio
    const fontSizeMap: Record<number, number> = {
      1: 0.8,   // 80%
      2: 0.9,   // 90% (default)
      3: 1.0,   // 100%
      4: 1.1,   // 110%
      5: 1.2,   // 120%
      6: 1.4,   // 140%
    };
    const scale = fontSizeMap[fontSizeLevel] || 1.0;

    // Apply to root element
    document.documentElement.style.setProperty('--font-scale', scale.toString());

    // Save to localStorage
    localStorage.setItem('fontSizeLevel', fontSizeLevel.toString());
  }, [fontSizeLevel]);

  // Chat background color handler
  useEffect(() => {
    if (chatBgColor) {
      document.documentElement.style.setProperty('--bg-chat', chatBgColor);
      localStorage.setItem('chatBgColor', chatBgColor);
    } else {
      document.documentElement.style.removeProperty('--bg-chat');
      localStorage.removeItem('chatBgColor');
    }
  }, [chatBgColor]);

  // Diff expanded by default handler
  useEffect(() => {
    try {
      if (diffExpandedByDefault) {
        localStorage.setItem('diffExpandedByDefault', 'true');
      } else {
        localStorage.removeItem('diffExpandedByDefault');
      }
    } catch { /* ignore storage errors */ }
  }, [diffExpandedByDefault]);

  useEffect(() => {
    if (isCodexMode && disabledTabs.includes(currentTab)) {
      setCurrentTab('basic');
    }
  }, [isCodexMode, disabledTabs, currentTab]);

  const handleSaveNodePath = () => {
    setSavingNodePath(true);
    const payload = { path: (nodePath || '').trim() };
    sendToJava(`set_node_path:${JSON.stringify(payload)}`);
  };

  const handleSaveWorkingDirectory = () => {
    setSavingWorkingDirectory(true);
    const payload = { customWorkingDir: (workingDirectory || '').trim() };
    sendToJava(`set_working_directory:${JSON.stringify(payload)}`);
  };

  // Streaming toggle change handler
  const handleStreamingEnabledChange = (enabled: boolean) => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onStreamingEnabledChangeProp) {
      onStreamingEnabledChangeProp(enabled);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalStreamingEnabled(enabled);
      const payload = { streamingEnabled: enabled };
      sendToJava(`set_streaming_enabled:${JSON.stringify(payload)}`);
    }
  };

  // Send shortcut change handler
  const handleSendShortcutChange = (shortcut: 'enter' | 'cmdEnter') => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onSendShortcutChangeProp) {
      onSendShortcutChangeProp(shortcut);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalSendShortcut(shortcut);
      const payload = { sendShortcut: shortcut };
      sendToJava(`set_send_shortcut:${JSON.stringify(payload)}`);
    }
  };

  // Auto open file toggle change handler
  const handleAutoOpenFileEnabledChange = (enabled: boolean) => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onAutoOpenFileEnabledChangeProp) {
      onAutoOpenFileEnabledChangeProp(enabled);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalAutoOpenFileEnabled(enabled);
      const payload = { autoOpenFileEnabled: enabled };
      sendToJava(`set_auto_open_file_enabled:${JSON.stringify(payload)}`);
    }
  };

  // Commit AI prompt save handler
  const handleSaveCommitPrompt = () => {
    setSavingCommitPrompt(true);
    const payload = { prompt: commitPrompt };
    sendToJava(`set_commit_prompt:${JSON.stringify(payload)}`);
  };

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
      sendToJava(`add_provider:${JSON.stringify(newProvider)}`);
      addToast(t('toast.providerAdded'), 'success');
    } else {
      // Update existing provider
      if (!providerDialog.provider) return;

      const providerId = providerDialog.provider.id;
      // Check if the currently edited provider is active
      // Prefer the latest state from providers list; fall back to dialog state if not found
      const currentProvider = providers.find(p => p.id === providerId) || providerDialog.provider;
      const isActive = currentProvider.isActive;

      const updateData = {
        id: providerId,
        updates,
      };
      sendToJava(`update_provider:${JSON.stringify(updateData)}`);
      addToast(t('toast.providerUpdated'), 'success');

      // If this is the currently active provider, immediately re-apply the configuration after update
      if (isActive) {
        syncActiveProviderModelMapping({
          ...currentProvider,
          settingsConfig: parsedConfig,
        });
        // Use setTimeout for a slight delay to ensure update_provider finishes first
        // Although usually unnecessary in a single-threaded model, added for safety
        setTimeout(() => {
          sendToJava(`switch_provider:${JSON.stringify({ id: providerId })}`);
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
              streamingEnabled={streamingEnabled}
              onStreamingEnabledChange={handleStreamingEnabledChange}
              sendShortcut={sendShortcut}
              onSendShortcutChange={handleSendShortcutChange}
              autoOpenFileEnabled={autoOpenFileEnabled}
              onAutoOpenFileEnabledChange={handleAutoOpenFileEnabledChange}
              chatBgColor={chatBgColor}
              onChatBgColorChange={setChatBgColor}
              diffExpandedByDefault={diffExpandedByDefault}
              onDiffExpandedByDefaultChange={setDiffExpandedByDefault}
            />
          </div>

          {/* Provider management (Claude + Codex internal tab switching) */}
          <div style={{ display: currentTab === 'providers' ? 'block' : 'none' }}>
            <ProviderTabSection
              currentProvider={currentProvider}
              claudeConfig={claudeConfig}
              claudeConfigLoading={claudeConfigLoading}
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
              addToast={addToast}
            />
          </div>

          {/* SDK dependency management */}
          <div style={{ display: currentTab === 'dependencies' ? 'block' : 'none' }}>
            <DependencySection addToast={addToast} />
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
            <PlaceholderSection type="permissions" />
          </div>

          {/* Commit AI configuration */}
          <div style={{ display: currentTab === 'commit' ? 'block' : 'none' }}>
            <CommitSection
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
              prompts={prompts}
              loading={promptsLoading}
              onAdd={handleAddPrompt}
              onEdit={handleEditPrompt}
              onDelete={handleDeletePrompt}
              onExport={handleExportPrompts}
              onImport={handleImportPromptsFile}
            />
          </div>

          {/* Skills */}
          <div style={{ display: currentTab === 'skills' ? 'block' : 'none' }}>
            <SkillsSettingsSection />
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
            <CommunitySection />
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
        promptDialog={promptDialog}
        deletePromptConfirm={deletePromptConfirm}
        onClosePromptDialog={handleClosePromptDialog}
        onSavePrompt={handleSavePrompt}
        onConfirmDeletePrompt={confirmDeletePrompt}
        onCancelDeletePrompt={cancelDeletePrompt}
        promptExportDialog={promptExportDialog}
        promptImportPreviewDialog={promptImportPreviewDialog}
        prompts={prompts}
        onClosePromptExportDialog={handleClosePromptExportDialog}
        onConfirmPromptExport={handleConfirmPromptExport}
        onClosePromptImportPreview={handleClosePromptImportPreview}
        onSaveImportedPrompts={handleSaveImportedPrompts}
        addToast={addToast}
      />

      {/* Toast notifications */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
};

export default SettingsView;
