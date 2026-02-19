import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, CodexProviderConfig, CodexCustomModel } from '../../types/provider';
import type { AgentConfig } from '../../types/agent';
import type { PromptConfig } from '../../types/prompt';
import { type ClaudeConfig } from './ConfigInfoDisplay';
import AlertDialog from '../AlertDialog';
import type { AlertType } from '../AlertDialog';
import ConfirmDialog from '../ConfirmDialog';
import { ToastContainer, type ToastMessage } from '../Toast';
import ProviderDialog from '../ProviderDialog';
import CodexProviderDialog from '../CodexProviderDialog';
import AgentDialog from '../AgentDialog';
import PromptDialog from '../PromptDialog';

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

// Import custom hooks
import {
  useProviderManagement,
  useCodexProviderManagement,
  useAgentManagement,
  usePromptManagement,
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
    syncActiveProviderCustomModels,
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
  } = useAgentManagement({
    onSuccess: (msg) => addToast(msg, 'success'),
  });

  // Use prompt management hook
  const {
    prompts,
    promptsLoading,
    promptDialog,
    deletePromptConfirm,
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

  // Show switch success dialog
  const showSwitchSuccess = (message: string) => {
    console.log('[SettingsView] showSwitchSuccess called:', message);
    showAlert('success', t('toast.switchSuccess'), message);
  };

  useEffect(() => {
    // Set up global callbacks - using update functions provided by hooks
    window.updateProviders = (jsonStr: string) => {
      try {
        const providersList: ProviderConfig[] = JSON.parse(jsonStr);
        updateProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse providers:', error);
        setLoading(false);
      }
    };

    window.updateActiveProvider = (jsonStr: string) => {
      try {
        const activeProvider: ProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          updateActiveProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active provider:', error);
      }
    };

    // Claude CLI configuration callback
    window.updateCurrentClaudeConfig = (jsonStr: string) => {
      try {
        const config: ClaudeConfig = JSON.parse(jsonStr);
        setClaudeConfig(config);
        setClaudeConfigLoading(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse claude config:', error);
        setClaudeConfigLoading(false);
      }
    };

    window.showError = (message: string) => {
      console.log('[SettingsView] window.showError called:', message);
      showAlert('error', t('toast.operationFailed'), message);
      setLoading(false);
      setSavingNodePath(false);
      setSavingWorkingDirectory(false);
      setSavingCommitPrompt(false);
    };

    window.showSwitchSuccess = (message: string) => {
      console.log('[SettingsView] window.showSwitchSuccess called:', message);
      showSwitchSuccess(message);
    };

    window.updateNodePath = (jsonStr: string) => {
      console.log('[SettingsView] window.updateNodePath called:', jsonStr);
      try {
        const data = JSON.parse(jsonStr);
        setNodePath(data.path || '');
        setNodeVersion(data.version || null);
        if (data.minVersion) {
          setMinNodeVersion(data.minVersion);
        }
      } catch (e) {
        // Backward compatible with legacy format (plain string path)
        console.warn('[SettingsView] Failed to parse updateNodePath JSON, fallback to legacy format:', e);
        setNodePath(jsonStr || '');
      }
      setSavingNodePath(false);
    };

    window.updateWorkingDirectory = (jsonStr: string) => {
      console.log('[SettingsView] window.updateWorkingDirectory called:', jsonStr);
      try {
        const data = JSON.parse(jsonStr);
        setWorkingDirectory(data.customWorkingDir || '');
        setSavingWorkingDirectory(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse working directory:', error);
        setSavingWorkingDirectory(false);
      }
    };

    window.showSuccess = (message: string) => {
      console.log('[SettingsView] window.showSuccess called:', message);
      showAlert('success', t('toast.operationSuccess'), message);
      setSavingNodePath(false);
      setSavingWorkingDirectory(false);
    };

    window.onEditorFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        setEditorFontConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse editor font config:', error);
      }
    };

    // IDE theme callback - save previous callback for restoration
    const previousOnIdeThemeReceived = window.onIdeThemeReceived;
    window.onIdeThemeReceived = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        setIdeTheme(theme);
        console.log('[SettingsView] IDE theme received:', themeData, 'resolved to:', theme);
        // Also invoke the previous callback (from App.tsx)
        previousOnIdeThemeReceived?.(jsonStr);
      } catch (error) {
        console.error('[SettingsView] Failed to parse IDE theme:', error);
      }
    };

    // Streaming configuration callback - only use local state when props are not passed from App.tsx
    const previousUpdateStreamingEnabled = window.updateStreamingEnabled;
    if (!onStreamingEnabledChangeProp) {
      window.updateStreamingEnabled = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          setLocalStreamingEnabled(data.streamingEnabled ?? true);
        } catch (error) {
          console.error('[SettingsView] Failed to parse streaming config:', error);
        }
      };
    }

    // Send shortcut configuration callback - only use local state when props are not passed from App.tsx
    const previousUpdateSendShortcut = window.updateSendShortcut;
    if (!onSendShortcutChangeProp) {
      window.updateSendShortcut = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          setLocalSendShortcut(data.sendShortcut ?? 'enter');
        } catch (error) {
          console.error('[SettingsView] Failed to parse send shortcut config:', error);
        }
      };
    }

    // Commit AI prompt callback
    window.updateCommitPrompt = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setCommitPrompt(data.commitPrompt || '');
        setSavingCommitPrompt(false);
        // If this is a save operation, show success toast
        if (data.saved) {
          addToast(t('toast.saveSuccess'), 'success');
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse commit prompt:', error);
        setSavingCommitPrompt(false);
        addToast(t('toast.saveFailed'), 'error');
      }
    };

    // Agent callback - using update functions provided by hooks
    const previousUpdateAgents = window.updateAgents;
    window.updateAgents = (jsonStr: string) => {
      try {
        const agentsList: AgentConfig[] = JSON.parse(jsonStr);
        updateAgents(agentsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agents:', error);
      }
      previousUpdateAgents?.(jsonStr);
    };

    window.agentOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        handleAgentOperationResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent operation result:', error);
      }
    };

    // Prompt library callback - using update functions provided by hooks
    const previousUpdatePrompts = window.updatePrompts;
    window.updatePrompts = (jsonStr: string) => {
      try {
        const promptsList: PromptConfig[] = JSON.parse(jsonStr);
        updatePrompts(promptsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompts:', error);
      }
      previousUpdatePrompts?.(jsonStr);
    };

    window.promptOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        handlePromptOperationResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompt operation result:', error);
      }
    };

    // Codex provider callbacks - using update functions provided by hooks
    window.updateCodexProviders = (jsonStr: string) => {
      try {
        const providersList: CodexProviderConfig[] = JSON.parse(jsonStr);
        updateCodexProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex providers:', error);
        setCodexLoading(false);
      }
    };

    window.updateActiveCodexProvider = (jsonStr: string) => {
      try {
        const activeProvider: CodexProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          updateActiveCodexProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active Codex provider:', error);
      }
    };

    window.updateCurrentCodexConfig = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        updateCurrentCodexConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex config:', error);
        setCodexConfigLoading(false);
      }
    };

    // Load provider list
    loadProviders();
    // Load Codex provider list
    loadCodexProviders();
    // Load agent list
    loadAgents();
    // Load prompt list
    loadPrompts();
    // Load current Claude CLI configuration
    loadClaudeConfig();
    // Load Node.js path
    sendToJava('get_node_path:');
    // Load working directory configuration
    sendToJava('get_working_directory:');
    // Load IDEA editor font configuration
    sendToJava('get_editor_font_config:');
    // Load streaming configuration
    sendToJava('get_streaming_enabled:');
    // Load Commit AI prompt
    sendToJava('get_commit_prompt:');

    return () => {
      // Clean up agent timeout timer - using cleanup function from hook
      cleanupAgentsTimeout();
      // Clean up prompt timeout timer - using cleanup function from hook
      cleanupPromptsTimeout();

      window.updateProviders = undefined;
      window.updateActiveProvider = undefined;
      window.updateCurrentClaudeConfig = undefined;
      window.showError = undefined;
      window.showSwitchSuccess = undefined;
      window.updateNodePath = undefined;
      window.updateWorkingDirectory = undefined;
      window.showSuccess = undefined;
      window.onEditorFontConfigReceived = undefined;
      // Restore previous IDE theme callback (from App.tsx)
      window.onIdeThemeReceived = previousOnIdeThemeReceived;
      // Restore previous streaming callback if we overrode it
      if (!onStreamingEnabledChangeProp) {
        window.updateStreamingEnabled = previousUpdateStreamingEnabled;
      }
      // Restore previous send shortcut callback if we overrode it
      if (!onSendShortcutChangeProp) {
        window.updateSendShortcut = previousUpdateSendShortcut;
      }
      window.updateCommitPrompt = undefined;
      window.updateAgents = previousUpdateAgents;
      window.agentOperationResult = undefined;
      // Cleanup Prompt callbacks
      window.updatePrompts = previousUpdatePrompts;
      window.promptOperationResult = undefined;
      // Cleanup Codex callbacks
      window.updateCodexProviders = undefined;
      window.updateActiveCodexProvider = undefined;
      window.updateCurrentCodexConfig = undefined;
    };

    // Request IDE theme info
    sendToJava('get_ide_theme:');
  }, [t, onStreamingEnabledChangeProp, onSendShortcutChangeProp]);

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

  useEffect(() => {
    if (isCodexMode && disabledTabs.includes(currentTab)) {
      setCurrentTab('basic');
    }
  }, [isCodexMode, disabledTabs, currentTab]);

  const loadClaudeConfig = () => {
    setClaudeConfigLoading(true);
    sendToJava('get_current_claude_config:');
  };

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
    customModels?: CodexCustomModel[];
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
      customModels: data.customModels,
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
        syncActiveProviderCustomModels({
          ...currentProvider,
          customModels: data.customModels,
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

      {/* In-page alert dialog */}
      <AlertDialog
        isOpen={alertDialog.isOpen}
        type={alertDialog.type}
        title={alertDialog.title}
        message={alertDialog.message}
        onClose={closeAlert}
      />

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title={t('settings.provider.deleteConfirm')}
        message={t('settings.provider.deleteProviderMessage', { name: deleteConfirm.provider?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDeleteProvider}
        onCancel={cancelDeleteProvider}
      />

      {/* Provider add/edit dialog */}
      <ProviderDialog
        isOpen={providerDialog.isOpen}
        provider={providerDialog.provider}
        onClose={handleCloseProviderDialog}
        onSave={handleSaveProviderFromDialog}
        onDelete={handleDeleteProvider}
        canDelete={true}
        addToast={addToast}
      />

      {/* Agent add/edit dialog */}
      <AgentDialog
        isOpen={agentDialog.isOpen}
        agent={agentDialog.agent}
        onClose={handleCloseAgentDialog}
        onSave={handleSaveAgentFromDialog}
      />

      {/* Agent delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteAgentConfirm.isOpen}
        title={t('settings.agent.deleteConfirmTitle')}
        message={t('settings.agent.deleteConfirmMessage', { name: deleteAgentConfirm.agent?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDeleteAgent}
        onCancel={cancelDeleteAgent}
      />

      {/* Prompt add/edit dialog */}
      <PromptDialog
        isOpen={promptDialog.isOpen}
        prompt={promptDialog.prompt}
        onClose={handleClosePromptDialog}
        onSave={handleSavePrompt}
      />

      {/* Prompt delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deletePromptConfirm.isOpen}
        title={t('settings.prompt.deleteConfirmTitle')}
        message={t('settings.prompt.deleteConfirmMessage', { name: deletePromptConfirm.prompt?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDeletePrompt}
        onCancel={cancelDeletePrompt}
      />

      {/* Codex provider add/edit dialog */}
      <CodexProviderDialog
        isOpen={codexProviderDialog.isOpen}
        provider={codexProviderDialog.provider}
        onClose={handleCloseCodexProviderDialog}
        onSave={handleSaveCodexProviderFromDialog}
        addToast={addToast}
      />

      {/* Codex provider delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteCodexConfirm.isOpen}
        title={t('settings.codexProvider.deleteConfirmTitle')}
        message={t('settings.codexProvider.deleteConfirmMessage', { name: deleteCodexConfirm.provider?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDeleteCodexProvider}
        onCancel={cancelDeleteCodexProvider}
      />

      {/* Toast notifications */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
};

export default SettingsView;
