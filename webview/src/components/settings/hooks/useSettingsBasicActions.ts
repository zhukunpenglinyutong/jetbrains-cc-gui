// hooks/useSettingsBasicActions.ts
import { useState, useEffect, useCallback } from 'react';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

export interface UseSettingsBasicActionsProps {
  streamingEnabledProp?: boolean;
  onStreamingEnabledChangeProp?: (enabled: boolean) => void;
  sendShortcutProp?: 'enter' | 'cmdEnter';
  onSendShortcutChangeProp?: (shortcut: 'enter' | 'cmdEnter') => void;
  autoOpenFileEnabledProp?: boolean;
  onAutoOpenFileEnabledChangeProp?: (enabled: boolean) => void;
}

export interface UseSettingsBasicActionsReturn {
  // =========================================================================
  // Public read-only state (safe to read in components)
  // =========================================================================
  nodePath: string;
  nodeVersion: string | null;
  minNodeVersion: number;
  savingNodePath: boolean;
  workingDirectory: string;
  savingWorkingDirectory: boolean;
  editorFontConfig:
    | {
        fontFamily: string;
        fontSize: number;
        lineSpacing: number;
      }
    | undefined;
  /** Streaming enabled state (prefers prop over local state) */
  streamingEnabled: boolean;
  localStreamingEnabled: boolean;
  codexSandboxMode: 'workspace-write' | 'danger-full-access';
  /** Send shortcut state (prefers prop over local state) */
  sendShortcut: 'enter' | 'cmdEnter';
  localSendShortcut: 'enter' | 'cmdEnter';
  /** Auto open file state (prefers prop over local state) */
  autoOpenFileEnabled: boolean;
  localAutoOpenFileEnabled: boolean;
  commitPrompt: string;
  savingCommitPrompt: boolean;
  soundNotificationEnabled: boolean;
  soundOnlyWhenUnfocused: boolean;
  selectedSound: string;
  customSoundPath: string;
  diffExpandedByDefault: boolean;
  historyCompletionEnabled: boolean;
  // F-008: Tracker path
  trackerPath: string;
  savingTrackerPath: boolean;
  trackerPathExists: boolean;
  // F-010: IPC Sniffer
  ipcSnifferEnabled: boolean;
  // B-029: Streaming render settings
  streamingRenderTables: boolean;
  streamingRenderLists: boolean;

  // =========================================================================
  // Handler functions (public API for components)
  // =========================================================================
  handleSaveNodePath: () => void;
  handleSaveWorkingDirectory: () => void;
  handleStreamingEnabledChange: (enabled: boolean) => void;
  handleCodexSandboxModeChange: (mode: 'workspace-write' | 'danger-full-access') => void;
  handleSendShortcutChange: (shortcut: 'enter' | 'cmdEnter') => void;
  handleAutoOpenFileEnabledChange: (enabled: boolean) => void;
  handleSoundNotificationEnabledChange: (enabled: boolean) => void;
  handleSoundOnlyWhenUnfocusedChange: (enabled: boolean) => void;
  handleSelectedSoundChange: (soundId: string) => void;
  handleCustomSoundPathChange: (path: string) => void;
  handleSaveCustomSoundPath: () => void;
  handleTestSound: () => void;
  handleBrowseSound: () => void;
  handleSaveCommitPrompt: () => void;
  // F-008: Tracker path
  handleSaveTrackerPath: () => void;
  // F-010: IPC Sniffer
  handleIpcSnifferEnabledChange: (enabled: boolean) => void;

  // =========================================================================
  // @internal — State setters used only by useSettingsWindowCallbacks.
  // Components should not call these directly; use handlers above instead.
  // =========================================================================
  /** @internal */ setNodePath: (path: string) => void;
  /** @internal */ setNodeVersion: (version: string | null) => void;
  /** @internal */ setMinNodeVersion: (version: number) => void;
  /** @internal */ setSavingNodePath: (saving: boolean) => void;
  /** @internal */ setWorkingDirectory: (dir: string) => void;
  /** @internal */ setSavingWorkingDirectory: (saving: boolean) => void;
  /** @internal */ setEditorFontConfig: (
    config:
      | {
          fontFamily: string;
          fontSize: number;
          lineSpacing: number;
        }
      | undefined
  ) => void;
  /** @internal */ setLocalStreamingEnabled: (enabled: boolean) => void;
  /** @internal */ setCodexSandboxMode: (mode: 'workspace-write' | 'danger-full-access') => void;
  /** @internal */ setLocalSendShortcut: (shortcut: 'enter' | 'cmdEnter') => void;
  /** @internal */ setLocalAutoOpenFileEnabled: (enabled: boolean) => void;
  /** @internal */ setCommitPrompt: (prompt: string) => void;
  /** @internal */ setSavingCommitPrompt: (saving: boolean) => void;
  /** @internal */ setSoundNotificationEnabled: (enabled: boolean) => void;
  /** @internal */ setSoundOnlyWhenUnfocused: (enabled: boolean) => void;
  /** @internal */ setSelectedSound: (soundId: string) => void;
  /** @internal */ setCustomSoundPath: (path: string) => void;
  /** @internal */ setDiffExpandedByDefault: (expanded: boolean) => void;
  /** @internal */ setHistoryCompletionEnabled: (enabled: boolean) => void;
  /** @internal */ setTrackerPath: (path: string) => void;
  /** @internal */ setSavingTrackerPath: (saving: boolean) => void;
  /** @internal */ setTrackerPathExists: (exists: boolean) => void;
  /** @internal */ setIpcSnifferEnabled: (enabled: boolean) => void;
  /** @internal */ setStreamingRenderTables: (enabled: boolean) => void;
  /** @internal */ setStreamingRenderLists: (enabled: boolean) => void;
}

export function useSettingsBasicActions({
  streamingEnabledProp,
  onStreamingEnabledChangeProp,
  sendShortcutProp,
  onSendShortcutChangeProp,
  autoOpenFileEnabledProp,
  onAutoOpenFileEnabledChangeProp,
}: UseSettingsBasicActionsProps): UseSettingsBasicActionsReturn {
  // Node.js path
  const [nodePath, setNodePath] = useState('');
  const [nodeVersion, setNodeVersion] = useState<string | null>(null);
  const [minNodeVersion, setMinNodeVersion] = useState(18);
  const [savingNodePath, setSavingNodePath] = useState(false);

  // Working directory configuration
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [savingWorkingDirectory, setSavingWorkingDirectory] = useState(false);

  // IDEA editor font configuration (read-only display)
  const [editorFontConfig, setEditorFontConfig] = useState<
    | {
        fontFamily: string;
        fontSize: number;
        lineSpacing: number;
      }
    | undefined
  >();

  // Streaming configuration - prefer props, fallback to local state
  const [localStreamingEnabled, setLocalStreamingEnabled] = useState<boolean>(false);
  const streamingEnabled = streamingEnabledProp ?? localStreamingEnabled;

  const [codexSandboxMode, setCodexSandboxMode] = useState<'workspace-write' | 'danger-full-access'>(
    'danger-full-access'
  );

  // Send shortcut configuration - prefer props, fallback to local state
  const [localSendShortcut, setLocalSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');
  const sendShortcut = sendShortcutProp ?? localSendShortcut;

  // Auto open file configuration - prefer props, fallback to local state
  const [localAutoOpenFileEnabled, setLocalAutoOpenFileEnabled] = useState<boolean>(false);
  const autoOpenFileEnabled = autoOpenFileEnabledProp ?? localAutoOpenFileEnabled;

  // Commit AI prompt configuration
  const [commitPrompt, setCommitPrompt] = useState('');
  const [savingCommitPrompt, setSavingCommitPrompt] = useState(false);

  // Sound notification configuration
  const [soundNotificationEnabled, setSoundNotificationEnabled] = useState<boolean>(false);
  const [soundOnlyWhenUnfocused, setSoundOnlyWhenUnfocused] = useState<boolean>(false);
  const [selectedSound, setSelectedSound] = useState<string>('default');
  const [customSoundPath, setCustomSoundPath] = useState<string>('');

  // F-008: Tracker path configuration
  const [trackerPath, setTrackerPath] = useState('');
  const [savingTrackerPath, setSavingTrackerPath] = useState(false);
  const [trackerPathExists, setTrackerPathExists] = useState(false);

  // F-010: IPC Sniffer toggle configuration
  const [ipcSnifferEnabled, setIpcSnifferEnabled] = useState(false);

  // Diff expanded by default configuration (localStorage-only)
  const [diffExpandedByDefault, setDiffExpandedByDefault] = useState<boolean>(() => {
    try {
      return localStorage.getItem('diffExpandedByDefault') === 'true';
    } catch {
      return false;
    }
  });

  // History completion toggle configuration
  const [historyCompletionEnabled, setHistoryCompletionEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('historyCompletionEnabled');
    return saved !== 'false'; // Enabled by default
  });

  // Streaming render: tables (localStorage-only, default ON)
  const [streamingRenderTables, setStreamingRenderTables] = useState<boolean>(() => {
    try { return localStorage.getItem('streamingRenderTables') !== 'false'; } catch { return true; }
  });

  // Streaming render: lists (localStorage-only, default OFF)
  const [streamingRenderLists, setStreamingRenderLists] = useState<boolean>(() => {
    try { return localStorage.getItem('streamingRenderLists') === 'true'; } catch { return false; }
  });

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

  // Streaming render settings handlers
  useEffect(() => {
    try { localStorage.setItem('streamingRenderTables', String(streamingRenderTables)); } catch { /* ignore */ }
  }, [streamingRenderTables]);

  useEffect(() => {
    try { localStorage.setItem('streamingRenderLists', String(streamingRenderLists)); } catch { /* ignore */ }
  }, [streamingRenderLists]);

  const handleSaveNodePath = useCallback(() => {
    setSavingNodePath(true);
    const payload = { path: (nodePath || '').trim() };
    sendToJava(`set_node_path:${JSON.stringify(payload)}`);
  }, [nodePath]);

  const handleSaveWorkingDirectory = useCallback(() => {
    setSavingWorkingDirectory(true);
    const payload = { customWorkingDir: (workingDirectory || '').trim() };
    sendToJava(`set_working_directory:${JSON.stringify(payload)}`);
  }, [workingDirectory]);

  // Streaming toggle change handler
  const handleStreamingEnabledChange = useCallback((enabled: boolean) => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onStreamingEnabledChangeProp) {
      onStreamingEnabledChangeProp(enabled);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalStreamingEnabled(enabled);
      const payload = { streamingEnabled: enabled };
      sendToJava(`set_streaming_enabled:${JSON.stringify(payload)}`);
    }
  }, [onStreamingEnabledChangeProp]);

  const handleCodexSandboxModeChange = useCallback((mode: 'workspace-write' | 'danger-full-access') => {
    setCodexSandboxMode(mode);
    const payload = { sandboxMode: mode };
    sendToJava(`set_codex_sandbox_mode:${JSON.stringify(payload)}`);
  }, []);

  // Send shortcut change handler
  const handleSendShortcutChange = useCallback((shortcut: 'enter' | 'cmdEnter') => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onSendShortcutChangeProp) {
      onSendShortcutChangeProp(shortcut);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalSendShortcut(shortcut);
      const payload = { sendShortcut: shortcut };
      sendToJava(`set_send_shortcut:${JSON.stringify(payload)}`);
    }
  }, [onSendShortcutChangeProp]);

  // Auto open file toggle change handler
  const handleAutoOpenFileEnabledChange = useCallback((enabled: boolean) => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onAutoOpenFileEnabledChangeProp) {
      onAutoOpenFileEnabledChangeProp(enabled);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalAutoOpenFileEnabled(enabled);
      const payload = { autoOpenFileEnabled: enabled };
      sendToJava(`set_auto_open_file_enabled:${JSON.stringify(payload)}`);
    }
  }, [onAutoOpenFileEnabledChangeProp]);

  // Sound notification toggle change handler
  const handleSoundNotificationEnabledChange = useCallback((enabled: boolean) => {
    setSoundNotificationEnabled(enabled);
    const payload = { enabled };
    sendToJava(`set_sound_notification_enabled:${JSON.stringify(payload)}`);
  }, []);

  // Sound only-when-unfocused toggle change handler
  const handleSoundOnlyWhenUnfocusedChange = useCallback((enabled: boolean) => {
    setSoundOnlyWhenUnfocused(enabled);
    const payload = { onlyWhenUnfocused: enabled };
    sendToJava(`set_sound_only_when_unfocused:${JSON.stringify(payload)}`);
  }, []);

  // Selected sound change handler
  const handleSelectedSoundChange = useCallback((soundId: string) => {
    setSelectedSound(soundId);
    const payload = { soundId };
    sendToJava(`set_selected_sound:${JSON.stringify(payload)}`);
  }, []);

  // Custom sound path change handler
  const handleCustomSoundPathChange = useCallback((path: string) => {
    setCustomSoundPath(path);
  }, []);

  // Save custom sound path
  const handleSaveCustomSoundPath = useCallback(() => {
    const payload = { path: customSoundPath };
    sendToJava(`set_custom_sound_path:${JSON.stringify(payload)}`);
  }, [customSoundPath]);

  // Test sound
  const handleTestSound = useCallback(() => {
    const payload = { soundId: selectedSound, path: customSoundPath };
    sendToJava(`test_sound:${JSON.stringify(payload)}`);
  }, [selectedSound, customSoundPath]);

  // Browse sound file
  const handleBrowseSound = useCallback(() => {
    sendToJava('browse_sound_file:');
  }, []);

  // F-008: Save tracker path
  const handleSaveTrackerPath = useCallback(() => {
    setSavingTrackerPath(true);
    const payload = { path: (trackerPath || '').trim() };
    sendToJava(`set_tracker_path:${JSON.stringify(payload)}`);
  }, [trackerPath]);

  // F-010: IPC Sniffer toggle handler
  const handleIpcSnifferEnabledChange = useCallback((enabled: boolean) => {
    setIpcSnifferEnabled(enabled);
    sendToJava(`set_ipc_sniffer_enabled:${JSON.stringify({ enabled })}`);
  }, []);

  // Commit AI prompt save handler
  const handleSaveCommitPrompt = useCallback(() => {
    setSavingCommitPrompt(true);
    const payload = { prompt: commitPrompt };
    sendToJava(`set_commit_prompt:${JSON.stringify(payload)}`);
  }, [commitPrompt]);

  return {
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
    localStreamingEnabled,
    setLocalStreamingEnabled,
    streamingEnabled,
    codexSandboxMode,
    setCodexSandboxMode,
    localSendShortcut,
    setLocalSendShortcut,
    sendShortcut,
    localAutoOpenFileEnabled,
    setLocalAutoOpenFileEnabled,
    autoOpenFileEnabled,
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
    // F-008
    trackerPath,
    setTrackerPath,
    savingTrackerPath,
    setSavingTrackerPath,
    trackerPathExists,
    setTrackerPathExists,
    handleSaveTrackerPath,
    // F-010
    ipcSnifferEnabled,
    setIpcSnifferEnabled,
    handleIpcSnifferEnabledChange,
    // B-029: streaming render settings
    streamingRenderTables,
    setStreamingRenderTables,
    streamingRenderLists,
    setStreamingRenderLists,
  };
}
