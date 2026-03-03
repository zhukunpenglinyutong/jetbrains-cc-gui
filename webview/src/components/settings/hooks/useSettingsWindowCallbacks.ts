// hooks/useSettingsWindowCallbacks.ts
import { useEffect, useRef } from 'react';
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
  // Sound notification setters
  setSoundNotificationEnabled?: (enabled: boolean) => void;
  setSelectedSound?: (soundId: string) => void;
  setCustomSoundPath?: (path: string) => void;

  // Hook functions
  updateProviders: (providers: ProviderConfig[]) => void;
  updateActiveProvider: (provider: ProviderConfig) => void;
  loadProviders: () => void;
  loadCodexProviders: () => void;
  loadAgents: () => void;
  loadPrompts: () => void;
  updateAgents: (agents: AgentConfig[]) => void;
  handleAgentOperationResult: (result: any) => void;
  handleAgentImportPreviewResult: (previewData: any) => void;
  handleAgentImportResult: (result: any) => void;
  updatePrompts: (prompts: PromptConfig[]) => void;
  handlePromptOperationResult: (result: any) => void;
  handlePromptImportPreviewResult: (previewData: any) => void;
  handlePromptImportResult: (result: any) => void;
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

  // Use ref to avoid stale closures - callbacks always read latest deps
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const d = () => depsRef.current;

    // Provider callbacks
    window.updateProviders = (jsonStr: string) => {
      try {
        const providersList: ProviderConfig[] = JSON.parse(jsonStr);
        d().updateProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse providers:', error);
        d().setLoading(false);
      }
    };

    window.updateActiveProvider = (jsonStr: string) => {
      try {
        const activeProvider: ProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          d().updateActiveProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active provider:', error);
      }
    };

    // Claude CLI configuration callback
    window.updateCurrentClaudeConfig = (jsonStr: string) => {
      try {
        const config: ClaudeConfig = JSON.parse(jsonStr);
        d().setClaudeConfig(config);
        d().setClaudeConfigLoading(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse claude config:', error);
        d().setClaudeConfigLoading(false);
      }
    };

    window.showError = (message: string) => {
      d().showAlert('error', t('toast.operationFailed'), message);
      d().setLoading(false);
      d().setSavingNodePath(false);
      d().setSavingWorkingDirectory(false);
      d().setSavingCommitPrompt(false);
    };

    window.showSwitchSuccess = (message: string) => {
      d().showAlert('success', t('toast.switchSuccess'), message);
    };

    window.updateNodePath = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setNodePath(data.path || '');
        d().setNodeVersion(data.version || null);
        if (data.minVersion) {
          d().setMinNodeVersion(data.minVersion);
        }
      } catch (e) {
        console.warn('[SettingsView] Failed to parse updateNodePath JSON, fallback to legacy format:', e);
        d().setNodePath(jsonStr || '');
      }
      d().setSavingNodePath(false);
      window.dispatchEvent(new CustomEvent('nodePathReady'));
    };

    window.updateWorkingDirectory = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setWorkingDirectory(data.customWorkingDir || '');
        d().setSavingWorkingDirectory(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse working directory:', error);
        d().setSavingWorkingDirectory(false);
      }
    };

    window.showSuccess = (message: string) => {
      d().showAlert('success', t('toast.operationSuccess'), message);
      d().setSavingNodePath(false);
      d().setSavingWorkingDirectory(false);
    };

    window.showSuccessI18n = (i18nKey: string) => {
      const message = t(i18nKey);
      d().addToast(message, 'success');
    };

    window.onEditorFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        d().setEditorFontConfig(config);
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
        d().setIdeTheme(theme);
        previousOnIdeThemeReceived?.(jsonStr);
      } catch (error) {
        console.error('[SettingsView] Failed to parse IDE theme:', error);
      }
    };

    // Streaming configuration callback
    const previousUpdateStreamingEnabled = window.updateStreamingEnabled;
    if (!d().onStreamingEnabledChangeProp) {
      window.updateStreamingEnabled = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          d().setLocalStreamingEnabled(data.streamingEnabled ?? true);
        } catch (error) {
          console.error('[SettingsView] Failed to parse streaming config:', error);
        }
      };
    }

    // Send shortcut configuration callback
    const previousUpdateSendShortcut = window.updateSendShortcut;
    if (!d().onSendShortcutChangeProp) {
      window.updateSendShortcut = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          d().setLocalSendShortcut(data.sendShortcut ?? 'enter');
        } catch (error) {
          console.error('[SettingsView] Failed to parse send shortcut config:', error);
        }
      };
    }

    // Commit AI prompt callback
    window.updateCommitPrompt = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setCommitPrompt(data.commitPrompt || '');
        d().setSavingCommitPrompt(false);
        if (data.saved) {
          d().addToast(t('toast.saveSuccess'), 'success');
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse commit prompt:', error);
        d().setSavingCommitPrompt(false);
        d().addToast(t('toast.saveFailed'), 'error');
      }
    };

    // Sound notification config callback
    window.updateSoundNotificationConfig = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        if (data.enabled !== undefined) {
          d().setSoundNotificationEnabled?.(data.enabled);
        }
        if (data.selectedSound !== undefined) {
          d().setSelectedSound?.(data.selectedSound);
        }
        if (data.customSoundPath !== undefined) {
          d().setCustomSoundPath?.(data.customSoundPath);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse sound notification config:', error);
      }
    };

    // Agent callbacks
    const previousUpdateAgents = window.updateAgents;
    window.updateAgents = (jsonStr: string) => {
      try {
        const agentsList: AgentConfig[] = JSON.parse(jsonStr);
        d().updateAgents(agentsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agents:', error);
      }
      previousUpdateAgents?.(jsonStr);
    };

    window.agentOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handleAgentOperationResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent operation result:', error);
      }
    };

    window.agentImportPreviewResult = (jsonStr: string) => {
      try {
        const previewData = JSON.parse(jsonStr);
        if (!Array.isArray(previewData?.items) || typeof previewData?.summary !== 'object') {
          console.error('[SettingsView] Invalid agent import preview data structure');
          return;
        }
        d().handleAgentImportPreviewResult(previewData);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent import preview result:', error);
      }
    };

    window.agentImportResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handleAgentImportResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent import result:', error);
      }
    };

    // Prompt library callbacks
    const previousUpdatePrompts = window.updatePrompts;
    window.updatePrompts = (jsonStr: string) => {
      try {
        const promptsList: PromptConfig[] = JSON.parse(jsonStr);
        d().updatePrompts(promptsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompts:', error);
      }
      previousUpdatePrompts?.(jsonStr);
    };

    window.promptOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handlePromptOperationResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompt operation result:', error);
      }
    };

    window.promptImportPreviewResult = (jsonStr: string) => {
      try {
        const previewData = JSON.parse(jsonStr);
        if (!Array.isArray(previewData?.items) || typeof previewData?.summary !== 'object') {
          console.error('[SettingsView] Invalid prompt import preview data structure');
          return;
        }
        d().handlePromptImportPreviewResult(previewData);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompt import preview result:', error);
      }
    };

    window.promptImportResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handlePromptImportResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompt import result:', error);
      }
    };

    // Codex provider callbacks
    window.updateCodexProviders = (jsonStr: string) => {
      try {
        const providersList: CodexProviderConfig[] = JSON.parse(jsonStr);
        d().updateCodexProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex providers:', error);
        d().setCodexLoading(false);
      }
    };

    window.updateActiveCodexProvider = (jsonStr: string) => {
      try {
        const activeProvider: CodexProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          d().updateActiveCodexProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active Codex provider:', error);
      }
    };

    window.updateCurrentCodexConfig = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        d().updateCurrentCodexConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex config:', error);
        d().setCodexConfigLoading(false);
      }
    };

    // Initial data loading
    d().loadProviders();
    d().loadCodexProviders();
    d().loadAgents();
    d().loadPrompts();
    d().setClaudeConfigLoading(true);
    sendToJava('get_current_claude_config:');
    sendToJava('get_node_path:');
    sendToJava('get_working_directory:');
    sendToJava('get_editor_font_config:');
    sendToJava('get_streaming_enabled:');
    sendToJava('get_commit_prompt:');
    sendToJava('get_sound_notification_config:');

    return () => {
      d().cleanupAgentsTimeout();
      d().cleanupPromptsTimeout();

      window.updateProviders = undefined;
      window.updateActiveProvider = undefined;
      window.updateCurrentClaudeConfig = undefined;
      window.showError = undefined;
      window.showSwitchSuccess = undefined;
      window.updateNodePath = undefined;
      window.updateWorkingDirectory = undefined;
      window.showSuccess = undefined;
      window.showSuccessI18n = undefined;
      window.onEditorFontConfigReceived = undefined;
      window.onIdeThemeReceived = previousOnIdeThemeReceived;
      if (!d().onStreamingEnabledChangeProp) {
        window.updateStreamingEnabled = previousUpdateStreamingEnabled;
      }
      if (!d().onSendShortcutChangeProp) {
        window.updateSendShortcut = previousUpdateSendShortcut;
      }
      window.updateCommitPrompt = undefined;
      window.updateSoundNotificationConfig = undefined;
      window.updateAgents = previousUpdateAgents;
      window.agentOperationResult = undefined;
      window.agentImportPreviewResult = undefined;
      window.agentImportResult = undefined;
      window.updatePrompts = previousUpdatePrompts;
      window.promptOperationResult = undefined;
      window.promptImportPreviewResult = undefined;
      window.promptImportResult = undefined;
      window.updateCodexProviders = undefined;
      window.updateActiveCodexProvider = undefined;
      window.updateCurrentCodexConfig = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);
}
