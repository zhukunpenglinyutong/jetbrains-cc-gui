// hooks/useSettingsWindowCallbacks.ts
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, CodexProviderConfig } from '../../../types/provider';
import type { AgentConfig } from '../../../types/agent';
import type { PromptConfig } from '../../../types/prompt';
import type { ClaudeConfig } from '../ConfigInfoDisplay';
import type { AlertType } from '../../AlertDialog';
import type { ToastMessage } from '../../Toast';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  } else {
    console.warn('[SettingsView] sendToJava is not available');
  }
};

export interface SettingsWindowCallbacksDeps {
  // State setters
  setClaudeConfig: (config: ClaudeConfig | null) => void;
  setClaudeConfigLoading: (loading: boolean) => void;
  setNodePath: (path: string) => void;
  setNodeVersion: (version: string | null) => void;
  setMinNodeVersion: (version: number) => void;
  setSavingNodePath: (saving: boolean) => void;
  setWorkingDirectory: (dir: string) => void;
  setSavingWorkingDirectory: (saving: boolean) => void;
  setCommitPrompt: (prompt: string) => void;
  setSavingCommitPrompt: (saving: boolean) => void;
  setEditorFontConfig: (config: { fontFamily: string; fontSize: number; lineSpacing: number } | undefined) => void;
  setIdeTheme: (theme: 'light' | 'dark' | null) => void;
  setLocalStreamingEnabled: (enabled: boolean) => void;
  setLocalSendShortcut: (shortcut: 'enter' | 'cmdEnter') => void;
  setLoading: (loading: boolean) => void;
  setCodexLoading: (loading: boolean) => void;
  setCodexConfigLoading: (loading: boolean) => void;

  // Hook functions
  updateProviders: (providers: ProviderConfig[]) => void;
  updateActiveProvider: (provider: ProviderConfig) => void;
  loadProviders: () => void;
  loadCodexProviders: () => void;
  loadAgents: () => void;
  loadPrompts: () => void;
  updateAgents: (agents: AgentConfig[]) => void;
  handleAgentOperationResult: (result: any) => void;
  updatePrompts: (prompts: PromptConfig[]) => void;
  handlePromptOperationResult: (result: any) => void;
  updateCodexProviders: (providers: CodexProviderConfig[]) => void;
  updateActiveCodexProvider: (provider: CodexProviderConfig) => void;
  updateCurrentCodexConfig: (config: any) => void;
  cleanupAgentsTimeout: () => void;
  cleanupPromptsTimeout: () => void;

  // Callbacks
  showAlert: (type: AlertType, title: string, message: string) => void;
  addToast: (message: string, type?: ToastMessage['type']) => void;

  // Props
  onStreamingEnabledChangeProp?: (enabled: boolean) => void;
  onSendShortcutChangeProp?: (shortcut: 'enter' | 'cmdEnter') => void;
}

/**
 * Registers window callbacks for Java bridge communication in settings view.
 * Handles provider, agent, prompt, config, and theme callbacks.
 */
export function useSettingsWindowCallbacks(deps: SettingsWindowCallbacksDeps) {
  const { t } = useTranslation();

  useEffect(() => {
    // Provider callbacks
    window.updateProviders = (jsonStr: string) => {
      try {
        const providersList: ProviderConfig[] = JSON.parse(jsonStr);
        deps.updateProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse providers:', error);
        deps.setLoading(false);
      }
    };

    window.updateActiveProvider = (jsonStr: string) => {
      try {
        const activeProvider: ProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          deps.updateActiveProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active provider:', error);
      }
    };

    // Claude CLI configuration callback
    window.updateCurrentClaudeConfig = (jsonStr: string) => {
      try {
        const config: ClaudeConfig = JSON.parse(jsonStr);
        deps.setClaudeConfig(config);
        deps.setClaudeConfigLoading(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse claude config:', error);
        deps.setClaudeConfigLoading(false);
      }
    };

    window.showError = (message: string) => {
      console.log('[SettingsView] window.showError called:', message);
      deps.showAlert('error', t('toast.operationFailed'), message);
      deps.setLoading(false);
      deps.setSavingNodePath(false);
      deps.setSavingWorkingDirectory(false);
      deps.setSavingCommitPrompt(false);
    };

    window.showSwitchSuccess = (message: string) => {
      console.log('[SettingsView] window.showSwitchSuccess called:', message);
      deps.showAlert('success', t('toast.switchSuccess'), message);
    };

    window.updateNodePath = (jsonStr: string) => {
      console.log('[SettingsView] window.updateNodePath called:', jsonStr);
      try {
        const data = JSON.parse(jsonStr);
        deps.setNodePath(data.path || '');
        deps.setNodeVersion(data.version || null);
        if (data.minVersion) {
          deps.setMinNodeVersion(data.minVersion);
        }
      } catch (e) {
        console.warn('[SettingsView] Failed to parse updateNodePath JSON, fallback to legacy format:', e);
        deps.setNodePath(jsonStr || '');
      }
      deps.setSavingNodePath(false);
    };

    window.updateWorkingDirectory = (jsonStr: string) => {
      console.log('[SettingsView] window.updateWorkingDirectory called:', jsonStr);
      try {
        const data = JSON.parse(jsonStr);
        deps.setWorkingDirectory(data.customWorkingDir || '');
        deps.setSavingWorkingDirectory(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse working directory:', error);
        deps.setSavingWorkingDirectory(false);
      }
    };

    window.showSuccess = (message: string) => {
      console.log('[SettingsView] window.showSuccess called:', message);
      deps.showAlert('success', t('toast.operationSuccess'), message);
      deps.setSavingNodePath(false);
      deps.setSavingWorkingDirectory(false);
    };

    window.onEditorFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        deps.setEditorFontConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse editor font config:', error);
      }
    };

    // IDE theme callback
    const previousOnIdeThemeReceived = window.onIdeThemeReceived;
    window.onIdeThemeReceived = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        deps.setIdeTheme(theme);
        console.log('[SettingsView] IDE theme received:', themeData, 'resolved to:', theme);
        previousOnIdeThemeReceived?.(jsonStr);
      } catch (error) {
        console.error('[SettingsView] Failed to parse IDE theme:', error);
      }
    };

    // Streaming configuration callback
    const previousUpdateStreamingEnabled = window.updateStreamingEnabled;
    if (!deps.onStreamingEnabledChangeProp) {
      window.updateStreamingEnabled = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          deps.setLocalStreamingEnabled(data.streamingEnabled ?? true);
        } catch (error) {
          console.error('[SettingsView] Failed to parse streaming config:', error);
        }
      };
    }

    // Send shortcut configuration callback
    const previousUpdateSendShortcut = window.updateSendShortcut;
    if (!deps.onSendShortcutChangeProp) {
      window.updateSendShortcut = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          deps.setLocalSendShortcut(data.sendShortcut ?? 'enter');
        } catch (error) {
          console.error('[SettingsView] Failed to parse send shortcut config:', error);
        }
      };
    }

    // Commit AI prompt callback
    window.updateCommitPrompt = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        deps.setCommitPrompt(data.commitPrompt || '');
        deps.setSavingCommitPrompt(false);
        if (data.saved) {
          deps.addToast(t('toast.saveSuccess'), 'success');
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse commit prompt:', error);
        deps.setSavingCommitPrompt(false);
        deps.addToast(t('toast.saveFailed'), 'error');
      }
    };

    // Agent callbacks
    const previousUpdateAgents = window.updateAgents;
    window.updateAgents = (jsonStr: string) => {
      try {
        const agentsList: AgentConfig[] = JSON.parse(jsonStr);
        deps.updateAgents(agentsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agents:', error);
      }
      previousUpdateAgents?.(jsonStr);
    };

    window.agentOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        deps.handleAgentOperationResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent operation result:', error);
      }
    };

    // Prompt library callbacks
    const previousUpdatePrompts = window.updatePrompts;
    window.updatePrompts = (jsonStr: string) => {
      try {
        const promptsList: PromptConfig[] = JSON.parse(jsonStr);
        deps.updatePrompts(promptsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompts:', error);
      }
      previousUpdatePrompts?.(jsonStr);
    };

    window.promptOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        deps.handlePromptOperationResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompt operation result:', error);
      }
    };

    // Codex provider callbacks
    window.updateCodexProviders = (jsonStr: string) => {
      try {
        const providersList: CodexProviderConfig[] = JSON.parse(jsonStr);
        deps.updateCodexProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex providers:', error);
        deps.setCodexLoading(false);
      }
    };

    window.updateActiveCodexProvider = (jsonStr: string) => {
      try {
        const activeProvider: CodexProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          deps.updateActiveCodexProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active Codex provider:', error);
      }
    };

    window.updateCurrentCodexConfig = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        deps.updateCurrentCodexConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex config:', error);
        deps.setCodexConfigLoading(false);
      }
    };

    // Initial data loading
    deps.loadProviders();
    deps.loadCodexProviders();
    deps.loadAgents();
    deps.loadPrompts();
    deps.setClaudeConfigLoading(true);
    sendToJava('get_current_claude_config:');
    sendToJava('get_node_path:');
    sendToJava('get_working_directory:');
    sendToJava('get_editor_font_config:');
    sendToJava('get_streaming_enabled:');
    sendToJava('get_commit_prompt:');

    return () => {
      deps.cleanupAgentsTimeout();
      deps.cleanupPromptsTimeout();

      window.updateProviders = undefined;
      window.updateActiveProvider = undefined;
      window.updateCurrentClaudeConfig = undefined;
      window.showError = undefined;
      window.showSwitchSuccess = undefined;
      window.updateNodePath = undefined;
      window.updateWorkingDirectory = undefined;
      window.showSuccess = undefined;
      window.onEditorFontConfigReceived = undefined;
      window.onIdeThemeReceived = previousOnIdeThemeReceived;
      if (!deps.onStreamingEnabledChangeProp) {
        window.updateStreamingEnabled = previousUpdateStreamingEnabled;
      }
      if (!deps.onSendShortcutChangeProp) {
        window.updateSendShortcut = previousUpdateSendShortcut;
      }
      window.updateCommitPrompt = undefined;
      window.updateAgents = previousUpdateAgents;
      window.agentOperationResult = undefined;
      window.updatePrompts = previousUpdatePrompts;
      window.promptOperationResult = undefined;
      window.updateCodexProviders = undefined;
      window.updateActiveCodexProvider = undefined;
      window.updateCurrentCodexConfig = undefined;
    };
  }, [t, deps.onStreamingEnabledChangeProp, deps.onSendShortcutChangeProp]);
}
