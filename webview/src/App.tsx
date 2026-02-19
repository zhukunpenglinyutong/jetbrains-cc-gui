import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import HistoryView from './components/history/HistoryView';
import SettingsView from './components/settings';
import type { SettingsTab } from './components/settings/SettingsSidebar';
import ConfirmDialog from './components/ConfirmDialog';
import PermissionDialog from './components/PermissionDialog';
import AskUserQuestionDialog from './components/AskUserQuestionDialog';
import PlanApprovalDialog from './components/PlanApprovalDialog';
import RewindDialog from './components/RewindDialog';
import RewindSelectDialog, { type RewindableMessage } from './components/RewindSelectDialog';
import { sendBridgeEvent } from './utils/bridge';
import { ChatInputBox } from './components/ChatInputBox';
import {
  useScrollBehavior,
  useDialogManagement,
  useSessionManagement,
  useStreamingMessages,
  useWindowCallbacks,
  useRewindHandlers,
  useHistoryLoader,
  useUsageStats,
  useFileChanges,
  useSubagents,
  useMessageQueue,
} from './hooks';
import type { ContextInfo } from './hooks';
import { createLocalizeMessage } from './utils/localizationUtils';
import { formatTime } from './utils/helpers';
import {
  normalizeBlocks as normalizeBlocksUtil,
  getMessageText as getMessageTextUtil,
  shouldShowMessage as shouldShowMessageUtil,
  getContentBlocks as getContentBlocksUtil,
  mergeConsecutiveAssistantMessages,
} from './utils/messageUtils';
import { CLAUDE_MODELS, CODEX_MODELS } from './components/ChatInputBox/types';
import type { Attachment, ChatInputBoxHandle, PermissionMode, ReasoningEffort, SelectedAgent } from './components/ChatInputBox/types';
import { StatusPanel, StatusPanelErrorBoundary } from './components/StatusPanel';
import { ToastContainer, type ToastMessage } from './components/Toast';
import { ScrollControl } from './components/ScrollControl';
import { extractMarkdownContent } from './utils/copyUtils';
import { ChatHeader } from './components/ChatHeader';
import { WelcomeScreen } from './components/WelcomeScreen';
import { MessageList } from './components/MessageList';
import { FILE_MODIFY_TOOL_NAMES, isToolName } from './utils/toolConstants';
import ChangelogDialog from './components/ChangelogDialog';
import { CHANGELOG_DATA } from './version/changelog';
import { APP_VERSION } from './version/version';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeRawMessage,
  HistoryData,
  TodoItem,
  ToolResultBlock,
} from './types';
import type { ProviderConfig } from './types/provider';

type ViewMode = 'chat' | 'history' | 'settings';

const DEFAULT_STATUS = 'ready';


const App = () => {
  const { t } = useTranslation();

  // Dialog management (permission, ask user question, plan approval, rewind)
  const {
    permissionDialogOpen,
    currentPermissionRequest,
    openPermissionDialog,
    handlePermissionApprove,
    handlePermissionApproveAlways,
    handlePermissionSkip,
    askUserQuestionDialogOpen,
    currentAskUserQuestionRequest,
    openAskUserQuestionDialog,
    handleAskUserQuestionSubmit,
    handleAskUserQuestionCancel,
    planApprovalDialogOpen,
    currentPlanApprovalRequest,
    openPlanApprovalDialog,
    handlePlanApprovalApprove,
    handlePlanApprovalReject,
    rewindDialogOpen,
    setRewindDialogOpen,
    currentRewindRequest,
    setCurrentRewindRequest,
    isRewinding,
    setIsRewinding,
    rewindSelectDialogOpen,
    setRewindSelectDialogOpen,
  } = useDialogManagement({ t });

  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [_status, setStatus] = useState(DEFAULT_STATUS); // Internal state, displayed via toast
  const [loading, setLoading] = useState(false);
  const [loadingStartTime, setLoadingStartTime] = useState<number | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingActive, setStreamingActive] = useState(false);
  const [currentView, setCurrentView] = useState<ViewMode>('chat');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  const [historyData, setHistoryData] = useState<HistoryData | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  // IDE theme state - prefer initial theme injected by Java
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    // Check if Java injected an initial theme
    const injectedTheme = (window as any).__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // Scroll behavior management
  const {
    messagesContainerRef,
    messagesEndRef,
    inputAreaRef,
    isUserAtBottomRef,
  } = useScrollBehavior({
    currentView,
    messages,
    loading,
    streamingActive,
  });

  // Streaming message state and helpers
  const {
    streamingContentRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    streamingMessageIndexRef,
    streamingTextSegmentsRef,
    activeTextSegmentIndexRef,
    streamingThinkingSegmentsRef,
    activeThinkingSegmentIndexRef,
    seenToolUseCountRef,
    contentUpdateTimeoutRef,
    thinkingUpdateTimeoutRef,
    lastContentUpdateRef,
    lastThinkingUpdateRef,
    autoExpandedThinkingKeysRef,
    findLastAssistantIndex,
    extractRawBlocks,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,
  } = useStreamingMessages();

  // ============================================================
  // Performance optimization: Use ref for ChatInputBox instead of controlled mode
  // This eliminates re-render loops caused by value/onInput sync
  // ============================================================
  const chatInputRef = useRef<ChatInputBoxHandle>(null);
  // Keep draftInput for backward compatibility (still used in some places)
  // but now it's updated via debounced callback, not on every keystroke
  const [draftInput, setDraftInput] = useState('');

  // ChatInputBox related state
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [selectedClaudeModel, setSelectedClaudeModel] = useState(CLAUDE_MODELS[0].id);
  const [selectedCodexModel, setSelectedCodexModel] = useState(CODEX_MODELS[0].id);
  const [claudePermissionMode, setClaudePermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  // Codex reasoning effort (thinking depth)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [usagePercentage, setUsagePercentage] = useState(0);
  const [usageUsedTokens, setUsageUsedTokens] = useState<number | undefined>(undefined);
  const [usageMaxTokens, setUsageMaxTokens] = useState<number | undefined>(undefined);
  const [, setProviderConfigVersion] = useState(0);
  const [activeProviderConfig, setActiveProviderConfig] = useState<ProviderConfig | null>(null);
  const [claudeSettingsAlwaysThinkingEnabled, setClaudeSettingsAlwaysThinkingEnabled] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<SelectedAgent | null>(null);
  // Streaming toggle state (synced with settings page)
  const [streamingEnabledSetting, setStreamingEnabledSetting] = useState(true);
  // Send shortcut setting
  const [sendShortcut, setSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');
  // Auto-open file setting
  const [autoOpenFileEnabled, setAutoOpenFileEnabled] = useState(true);
  // StatusPanel expanded/collapsed state (collapsed by default, auto-expands when content is present)
  const [statusPanelExpanded, setStatusPanelExpanded] = useState(false);
  // List of processed file paths (filtered from fileChanges after Apply/Reject, persisted to localStorage)
  const [processedFiles, setProcessedFiles] = useState<string[]>([]);
  // Base message index (for Keep All feature, only counts changes after this index)
  const [baseMessageIndex, setBaseMessageIndex] = useState(0);

  // Changelog dialog state (show once per version update)
  const LAST_SEEN_VERSION_KEY = 'lastSeenChangelogVersion';
  const [showChangelogDialog, setShowChangelogDialog] = useState(() => {
    const lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
    return lastSeen !== APP_VERSION;
  });
  const handleCloseChangelog = useCallback(() => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION);
    setShowChangelogDialog(false);
  }, []);

  // SDK installation status (used to prevent sending messages when SDK is not installed)
  const [sdkStatus, setSdkStatus] = useState<Record<string, { installed?: boolean; status?: string }>>({});
  const [sdkStatusLoaded, setSdkStatusLoaded] = useState(false); // Whether SDK status has been loaded from backend

  // Use useRef to store the latest provider value, avoiding stale closures in callbacks
  const currentProviderRef = useRef(currentProvider);
  useEffect(() => {
    currentProviderRef.current = currentProvider;
  }, [currentProvider]);

  // Use useRef to store the latest sessionId value for access in callbacks
  const currentSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // Context state (active file and selection) - retained for ContextBar display
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  // Select the displayed model based on the current provider
  const selectedModel = currentProvider === 'codex' ? selectedCodexModel : selectedClaudeModel;

  // Determine whether the SDK for the current provider is installed
  const currentSdkInstalled = (() => {
    // Return false when status hasn't loaded yet (show loading or not-installed prompt)
    if (!sdkStatusLoaded) return false;
    // Provider -> SDK mapping
    const providerToSdk: Record<string, string> = {
      claude: 'claude-sdk',
      anthropic: 'claude-sdk',
      bedrock: 'claude-sdk',
      codex: 'codex-sdk',
      openai: 'codex-sdk',
    };
    const sdkId = providerToSdk[currentProvider] || 'claude-sdk';
    const status = sdkStatus[sdkId];
    // Check the status field (preferred) or the installed field
    return status?.status === 'installed' || status?.installed === true;
  })();

  const syncActiveProviderModelMapping = (provider?: ProviderConfig | null) => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!provider || !provider.settingsConfig || !provider.settingsConfig.env) {
      try {
        window.localStorage.removeItem('claude-model-mapping');
      } catch {
      }
      return;
    }
    const env = provider.settingsConfig.env as Record<string, any>;
    const mapping = {
      main: env.ANTHROPIC_MODEL ?? '',
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
    };
    const hasValue = Object.values(mapping).some(v => v && String(v).trim().length > 0);
    try {
      if (hasValue) {
        window.localStorage.setItem('claude-model-mapping', JSON.stringify(mapping));
      } else {
        window.localStorage.removeItem('claude-model-mapping');
      }
    } catch {
    }
  };

  // Global drag event interception - prevent browser default file-open behavior
  // This ensures dragging files anywhere in the plugin won't trigger the browser to open files
  useEffect(() => {
    const preventDefaultDragDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Intercept all dragover and drop events at the document level
    document.addEventListener('dragover', preventDefaultDragDrop);
    document.addEventListener('drop', preventDefaultDragDrop);
    // Also handle dragenter and dragleave to prevent any unexpected behavior
    document.addEventListener('dragenter', preventDefaultDragDrop);

    return () => {
      document.removeEventListener('dragover', preventDefaultDragDrop);
      document.removeEventListener('drop', preventDefaultDragDrop);
      document.removeEventListener('dragenter', preventDefaultDragDrop);
    };
  }, []);

  // Initialize theme and font scaling
  useEffect(() => {
    // Register IDE theme received callback
    window.onIdeThemeReceived = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        setIdeTheme(theme);
      } catch {
        // Failed to parse IDE theme response
      }
    };

    // Listen for IDE theme changes (when user switches theme in the IDE)
    window.onIdeThemeChanged = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        setIdeTheme(theme);
      } catch {
        // Failed to parse IDE theme change
      }
    };

    // Initialize font scaling
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 2; // Default level 2 (90%)
    const fontSizeLevel = (level >= 1 && level <= 6) ? level : 2;

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
    document.documentElement.style.setProperty('--font-scale', scale.toString());

    // Initialize chat background color (validate hex format before applying)
    const savedChatBgColor = localStorage.getItem('chatBgColor');
    if (savedChatBgColor && /^#[0-9a-fA-F]{6}$/.test(savedChatBgColor)) {
      document.documentElement.style.setProperty('--bg-chat', savedChatBgColor);
    }

    // Apply the user's explicit theme choice (light/dark) first; Follow IDE mode is handled after ideTheme updates
    const savedTheme = localStorage.getItem('theme');

    // Check if there's an initial theme injected by Java
    const injectedTheme = (window as any).__INITIAL_IDE_THEME__;

    // Request IDE theme (with retry mechanism) - still needed for handling dynamic theme changes
    let retryCount = 0;
    const MAX_RETRIES = 20; // Max 20 retries (2 seconds)

    const requestIdeTheme = () => {
      if (window.sendToJava) {
        window.sendToJava('get_ide_theme:');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          setTimeout(requestIdeTheme, 100);
        } else {
          // If in Follow IDE mode and unable to get IDE theme, use injected theme or dark as fallback
          if (savedTheme === null || savedTheme === 'system') {
            const fallback = injectedTheme || 'dark';
            setIdeTheme(fallback as 'light' | 'dark');
          }
        }
      }
    };

    // Delay 100ms before requesting, giving the bridge time to initialize
    setTimeout(requestIdeTheme, 100);
  }, []);

  // Re-apply theme when IDE theme changes (if user chose "Follow IDE")
  // This effect also handles the theme setup on initial load
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');

    // Only process after ideTheme has been loaded
    if (ideTheme === null) {
      return;
    }

    // If user selected "Follow IDE" mode
    if (savedTheme === null || savedTheme === 'system') {
      document.documentElement.setAttribute('data-theme', ideTheme);
    }
  }, [ideTheme]);

  // Load model selection state from LocalStorage and sync to backend
  useEffect(() => {
    try {
      const saved = localStorage.getItem('model-selection-state');
      let restoredProvider = 'claude';
      let restoredClaudeModel = CLAUDE_MODELS[0].id;
      let restoredCodexModel = CODEX_MODELS[0].id;
      let initialPermissionMode: PermissionMode = 'bypassPermissions';

      if (saved) {
        const state = JSON.parse(saved);

        // Validate and restore provider
        if (['claude', 'codex'].includes(state.provider)) {
          restoredProvider = state.provider;
          setCurrentProvider(state.provider);
          if (state.provider === 'codex') {
            initialPermissionMode = 'bypassPermissions';
          }
        }

        // Validate and restore Claude model
        if (CLAUDE_MODELS.find(m => m.id === state.claudeModel)) {
          restoredClaudeModel = state.claudeModel;
          setSelectedClaudeModel(state.claudeModel);
        }

        // Validate and restore Codex model
        if (CODEX_MODELS.find(m => m.id === state.codexModel)) {
          restoredCodexModel = state.codexModel;
          setSelectedCodexModel(state.codexModel);
        }
      }

      setPermissionMode(initialPermissionMode);

      // Sync model state to backend on initialization to ensure frontend-backend consistency
      let syncRetryCount = 0;
      const MAX_SYNC_RETRIES = 30; // Max 30 retries (3 seconds)

      const syncToBackend = () => {
        if (window.sendToJava) {
          // Sync provider first
          sendBridgeEvent('set_provider', restoredProvider);
          // Then sync the corresponding model
          const modelToSync = restoredProvider === 'codex' ? restoredCodexModel : restoredClaudeModel;
          sendBridgeEvent('set_model', modelToSync);
          sendBridgeEvent('set_mode', initialPermissionMode);
        } else {
          // If sendToJava is not ready yet, retry later
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          }
        }
      };
      // Delay sync, waiting for bridge to be ready
      setTimeout(syncToBackend, 200);
    } catch {
      // Failed to load model selection state
    }
  }, []);

  // Save model selection state to LocalStorage
  useEffect(() => {
    try {
      localStorage.setItem('model-selection-state', JSON.stringify({
        provider: currentProvider,
        claudeModel: selectedClaudeModel,
        codexModel: selectedCodexModel,
      }));
    } catch {
      // Failed to save model selection state
    }
  }, [currentProvider, selectedClaudeModel, selectedCodexModel]);

  // Load selected agent
  useEffect(() => {
    let retryCount = 0;
    const MAX_RETRIES = 10; // Reduced to 10 retries, 1 second total
    let timeoutId: number | undefined;

    const loadSelectedAgent = () => {
      if (window.sendToJava) {
        sendBridgeEvent('get_selected_agent');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          timeoutId = window.setTimeout(loadSelectedAgent, 100);
        }
        // Even if loading fails, it doesn't affect other features
      }
    };

    timeoutId = window.setTimeout(loadSelectedAgent, 200); // Reduced initial delay to 200ms

    return () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  // Toast helper functions
  const addToast = (message: string, type: ToastMessage['type'] = 'info') => {
    // Don't show toast for default status
    if (message === DEFAULT_STATUS || !message) return;

    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  // Session management (create, load, delete, export, etc.)
  const {
    showNewSessionConfirm,
    showInterruptConfirm,
    suppressNextStatusToastRef,
    createNewSession,
    forceCreateNewSession,
    handleConfirmNewSession,
    handleCancelNewSession,
    handleConfirmInterrupt,
    handleCancelInterrupt,
    loadHistorySession,
    deleteHistorySession,
    exportHistorySession,
    toggleFavoriteSession,
    updateHistoryTitle,
  } = useSessionManagement({
    messages,
    loading,
    historyData,
    currentSessionId,
    setHistoryData,
    setMessages,
    setCurrentView,
    setCurrentSessionId,
    setUsagePercentage,
    setUsageUsedTokens,
    addToast,
    t,
  });

  // History data loading
  useHistoryLoader({ currentView, currentProvider });

  // Usage statistics polling
  useUsageStats();

  // Window callbacks (bridge communication)
  useWindowCallbacks({
    t,
    addToast,
    setMessages,
    setStatus,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setStreamingActive,
    setHistoryData,
    setCurrentSessionId,
    setUsagePercentage,
    setUsageUsedTokens,
    setUsageMaxTokens,
    setPermissionMode,
    setClaudePermissionMode,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setProviderConfigVersion,
    setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled,
    setStreamingEnabledSetting,
    setSendShortcut,
    setAutoOpenFileEnabled,
    setSdkStatus,
    setSdkStatusLoaded,
    setIsRewinding,
    setRewindDialogOpen,
    setCurrentRewindRequest,
    setContextInfo,
    setSelectedAgent,
    currentProviderRef,
    messagesContainerRef,
    isUserAtBottomRef,
    suppressNextStatusToastRef,
    streamingContentRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingTextSegmentsRef,
    activeTextSegmentIndexRef,
    streamingThinkingSegmentsRef,
    activeThinkingSegmentIndexRef,
    seenToolUseCountRef,
    streamingMessageIndexRef,
    lastContentUpdateRef,
    contentUpdateTimeoutRef,
    lastThinkingUpdateRef,
    thinkingUpdateTimeoutRef,
    findLastAssistantIndex,
    extractRawBlocks,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,
    syncActiveProviderModelMapping,
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
  });

  /**
   * Set of commands that trigger new session creation (/new, /clear, /reset)
   */
  const NEW_SESSION_COMMANDS = new Set(['/new', '/clear', '/reset']);

  /**
   * Check if the input is a new session command
   * @returns true if it was a new session command (handled), false otherwise
   */
  const checkNewSessionCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;
    const command = text.split(/\s+/)[0].toLowerCase();
    if (NEW_SESSION_COMMANDS.has(command)) {
      forceCreateNewSession();
      return true;
    }
    return false;
  }, [forceCreateNewSession]);

  /**
   * Check for unimplemented slash commands
   * @returns true if it was an unimplemented command (handled), false otherwise
   */
  const checkUnimplementedCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;

    const command = text.split(/\s+/)[0].toLowerCase();
    const unimplementedCommands = ['/plugin', '/plugins'];

    if (unimplementedCommands.includes(command)) {
      const userMessage: ClaudeMessage = {
        type: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      };
      const assistantMessage: ClaudeMessage = {
        type: 'assistant',
        content: t('chat.commandNotImplemented', { command }),
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      return true;
    }
    return false;
  }, [t]);

  /**
   * Build content blocks for the user message
   */
  const buildUserContentBlocks = useCallback((
    text: string,
    attachments: Attachment[] | undefined
  ): ClaudeContentBlock[] => {
    const blocks: ClaudeContentBlock[] = [];

    const hasImageAttachments = Array.isArray(attachments) &&
      attachments.some(att => att.mediaType?.startsWith('image/'));

    if (Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        if (att.mediaType?.startsWith('image/')) {
          blocks.push({
            type: 'image',
            src: `data:${att.mediaType};base64,${att.data}`,
            mediaType: att.mediaType,
          });
        } else {
          blocks.push({
            type: 'attachment',
            fileName: att.fileName,
            mediaType: att.mediaType,
          });
        }
      }
    }

    // Filter placeholder text: skip if there are image attachments and text is placeholder
    const isPlaceholderText = text && text.trim().startsWith('[Uploaded ');

    if (text && !(hasImageAttachments && isPlaceholderText)) {
      blocks.push({ type: 'text', text });
    }

    return blocks;
  }, [t]);

  /**
   * Send message to backend
   */
  const sendMessageToBackend = useCallback((
    text: string,
    attachments: Attachment[] | undefined,
    agentInfo: { id: string; name: string; prompt?: string } | null,
    fileTagsInfo: { displayPath: string; absolutePath: string }[] | null
  ) => {
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (hasAttachments) {
      try {
        const payload = JSON.stringify({
          text,
          attachments: (attachments || []).map(a => ({
            fileName: a.fileName,
            mediaType: a.mediaType,
            data: a.data,
          })),
          agent: agentInfo,
          fileTags: fileTagsInfo,
        });
        sendBridgeEvent('send_message_with_attachments', payload);
      } catch (error) {
        console.error('[Frontend] Failed to serialize attachments payload', error);
        const fallbackPayload = JSON.stringify({ text, agent: agentInfo, fileTags: fileTagsInfo });
        sendBridgeEvent('send_message', fallbackPayload);
      }
    } else {
      const payload = JSON.stringify({ text, agent: agentInfo, fileTags: fileTagsInfo });
      sendBridgeEvent('send_message', payload);
    }
  }, []);

  /**
   * Execute message sending (from queue or directly)
   */
  const executeMessage = useCallback((content: string, attachments?: Attachment[]) => {
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!text && !hasAttachments) return;

    // Check SDK status
    if (!sdkStatusLoaded) {
      addToast(t('chat.sdkStatusLoading'), 'info');
      return;
    }
    if (!currentSdkInstalled) {
      addToast(
        t('chat.sdkNotInstalled', { provider: currentProvider === 'codex' ? 'Codex' : 'Claude Code' }) + ' ' + t('chat.goInstallSdk'),
        'warning'
      );
      setSettingsInitialTab('dependencies');
      setCurrentView('settings');
      return;
    }

    // Build user message content blocks
    const userContentBlocks = buildUserContentBlocks(text, attachments);
    if (userContentBlocks.length === 0) return;

    // Persist non-image attachment metadata to ensure file chips remain visible after backend replaces optimistic messages
    const nonImageAttachments = Array.isArray(attachments)
      ? attachments.filter(a => !a.mediaType?.startsWith('image/'))
      : [];
    if (nonImageAttachments.length > 0) {
      // Limit cache size to prevent unbounded memory growth (keep last 100 entries)
      const MAX_ATTACHMENT_CACHE_SIZE = 100;
      if (sentAttachmentsRef.current.size >= MAX_ATTACHMENT_CACHE_SIZE) {
        // Delete the oldest entry (Map maintains insertion order)
        const firstKey = sentAttachmentsRef.current.keys().next().value;
        if (firstKey !== undefined) {
          sentAttachmentsRef.current.delete(firstKey);
        }
      }
      sentAttachmentsRef.current.set(text || '', nonImageAttachments.map(a => ({
        fileName: a.fileName,
        mediaType: a.mediaType,
      })));
    }

    // Create and add user message (optimistic update)
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: text || '',
      timestamp: new Date().toISOString(),
      isOptimistic: true,
      raw: { message: { content: userContentBlocks } },
    };
    setMessages((prev) => [...prev, userMessage]);

    // Set loading state
    setLoading(true);
    setLoadingStartTime(Date.now());

    // Scroll to bottom
    isUserAtBottomRef.current = true;
    requestAnimationFrame(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    });

    // Sync provider setting
    sendBridgeEvent('set_provider', currentProvider);

    // Build agent info
    const agentInfo = selectedAgent ? {
      id: selectedAgent.id,
      name: selectedAgent.name,
      prompt: selectedAgent.prompt,
    } : null;

    // Extract file tag info
    const fileTags = chatInputRef.current?.getFileTags() ?? [];
    const fileTagsInfo = fileTags.length > 0 ? fileTags.map(tag => ({
      displayPath: tag.displayPath,
      absolutePath: tag.absolutePath,
    })) : null;

    // Send message to backend
    sendMessageToBackend(text, attachments, agentInfo, fileTagsInfo);
  }, [
    sdkStatusLoaded,
    currentSdkInstalled,
    currentProvider,
    selectedAgent,
    buildUserContentBlocks,
    sendMessageToBackend,
    addToast,
    t,
  ]);

  /**
   * Message queue management
   */
  const {
    queue: messageQueue,
    enqueue: enqueueMessage,
    dequeue: dequeueMessage,
  } = useMessageQueue({
    isLoading: loading,
    onExecute: executeMessage,
  });

  /**
   * Handle message submission (from ChatInputBox)
   */
  const handleSubmit = (content: string, attachments?: Attachment[]) => {
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    // Validate input
    if (!text && !hasAttachments) return;

    // Check new session commands (/new, /clear, /reset) - no SDK needed, no confirmation, works even while loading
    if (checkNewSessionCommand(text)) return;

    // If loading, add to queue
    if (loading) {
      enqueueMessage(content, attachments);
      return;
    }

    // Check for unimplemented commands
    if (checkUnimplementedCommand(text)) return;

    // Execute message
    executeMessage(content, attachments);
  };

  /**
   * Handle mode selection
   */
  const handleModeSelect = (mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      setPermissionMode('bypassPermissions');
      sendBridgeEvent('set_mode', 'bypassPermissions');
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  };

  /**
   * Handle model selection
   */
  const handleModelSelect = (modelId: string) => {
    if (currentProvider === 'claude') {
      setSelectedClaudeModel(modelId);
    } else if (currentProvider === 'codex') {
      setSelectedCodexModel(modelId);
    }
    sendBridgeEvent('set_model', modelId);
  };

  /**
   * Handle provider selection
   * Clears messages and input box when switching provider (similar to creating a new session)
   */
  const handleProviderSelect = (providerId: string) => {
    // Clear message list (similar to creating a new session)
    setMessages([]);
    // Clear input box
    chatInputRef.current?.clear();

    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);
    const modeToSet = providerId === 'codex' ? 'bypassPermissions' : claudePermissionMode;
    setPermissionMode(modeToSet);
    sendBridgeEvent('set_mode', modeToSet);

    // When switching provider, also send the corresponding model
    const newModel = providerId === 'codex' ? selectedCodexModel : selectedClaudeModel;
    sendBridgeEvent('set_model', newModel);
  };

  /**
   * Handle reasoning effort selection (Codex only)
   */
  const handleReasoningChange = (effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  };

  /**
   * Handle agent selection
   */
  const handleAgentSelect = (agent: SelectedAgent | null) => {
    setSelectedAgent(agent);
    if (agent) {
      sendBridgeEvent('set_selected_agent', JSON.stringify({
        id: agent.id,
        name: agent.name,
        prompt: agent.prompt,
      }));
    } else {
      sendBridgeEvent('set_selected_agent', '');
    }
  };

  /**
   * Handle thinking mode toggle
   */
  const handleToggleThinking = (enabled: boolean) => {
    if (!activeProviderConfig) {
      setClaudeSettingsAlwaysThinkingEnabled(enabled);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    // Update local state (optimistic update)
    setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled
      }
    } : null);

    // Send update to backend
    const payload = JSON.stringify({
      id: activeProviderConfig.id,
      updates: {
        settingsConfig: {
          ...(activeProviderConfig.settingsConfig || {}),
          alwaysThinkingEnabled: enabled
        }
      }
    });
    sendBridgeEvent('update_provider', payload);
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  };

  /**
   * Handle streaming toggle
   */
  const handleStreamingEnabledChange = useCallback((enabled: boolean) => {
    setStreamingEnabledSetting(enabled);
    const payload = { streamingEnabled: enabled };
    sendBridgeEvent('set_streaming_enabled', JSON.stringify(payload));
    addToast(enabled ? t('settings.basic.streaming.enabled') : t('settings.basic.streaming.disabled'), 'success');
  }, [t, addToast]);

  /**
   * Handle send shortcut change
   */
  const handleSendShortcutChange = useCallback((shortcut: 'enter' | 'cmdEnter') => {
    setSendShortcut(shortcut);
    const payload = { sendShortcut: shortcut };
    sendBridgeEvent('set_send_shortcut', JSON.stringify(payload));
  }, []);

  /**
   * Handle auto-open file toggle
   */
  const handleAutoOpenFileEnabledChange = useCallback((enabled: boolean) => {
    setAutoOpenFileEnabled(enabled);
    const payload = { autoOpenFileEnabled: enabled };
    sendBridgeEvent('set_auto_open_file_enabled', JSON.stringify(payload));
    addToast(enabled ? t('settings.basic.autoOpenFile.enabled') : t('settings.basic.autoOpenFile.disabled'), 'success');
  }, [t, addToast]);

  const interruptSession = () => {
    // FIX: Reset frontend state immediately without waiting for backend callback
    // This lets the user see the stop effect right away
    setLoading(false);
    setLoadingStartTime(null);
    setStreamingActive(false);
    isStreamingRef.current = false;

    sendBridgeEvent('interrupt_session');
  };

  // Message utility functions (use imported utilities with bound dependencies)
  const localizeMessage = useMemo(() => createLocalizeMessage(t), [t]);

  // Cache for normalizeBlocks to avoid re-parsing unchanged messages
  const normalizeBlocksCache = useRef(new WeakMap<object, ClaudeContentBlock[]>());
  const shouldShowMessageCache = useRef(new WeakMap<object, boolean>());
  const mergedAssistantMessageCache = useRef(new Map<string, { source: ClaudeMessage[]; merged: ClaudeMessage }>());
  // Persistent storage: non-image attachment metadata from sent messages, used to display file chips in bubbles after backend message replacement
  const sentAttachmentsRef = useRef(new Map<string, Array<{ fileName: string; mediaType: string }>>());
  // Clear cache when dependencies change
  useEffect(() => {
    normalizeBlocksCache.current = new WeakMap();
    shouldShowMessageCache.current = new WeakMap();
    mergedAssistantMessageCache.current = new Map();
    sentAttachmentsRef.current.clear();
  }, [localizeMessage, t, currentSessionId]);

  const normalizeBlocks = useCallback(
    (raw?: ClaudeRawMessage | string) => {
      if (!raw) return null;
      if (typeof raw === 'object') {
        const cache = normalizeBlocksCache.current;
        if (cache.has(raw)) {
          return cache.get(raw)!;
        }
        const result = normalizeBlocksUtil(raw, localizeMessage, t);
        if (result) {
          cache.set(raw, result);
        }
        return result;
      }
      return normalizeBlocksUtil(raw, localizeMessage, t);
    },
    [localizeMessage, t]
  );

  const getMessageText = useCallback(
    (message: ClaudeMessage) => getMessageTextUtil(message, localizeMessage, t),
    [localizeMessage, t]
  );

  const shouldShowMessage = useCallback(
    (message: ClaudeMessage) => shouldShowMessageUtil(message, getMessageText, normalizeBlocks, t),
    [getMessageText, normalizeBlocks, t]
  );

  const shouldShowMessageCached = useCallback(
    (message: ClaudeMessage) => {
      const cache = shouldShowMessageCache.current;
      if (cache.has(message)) {
        return cache.get(message)!;
      }
      const result = shouldShowMessage(message);
      cache.set(message, result);
      return result;
    },
    [shouldShowMessage]
  );

  const getContentBlocks = useCallback(
    (message: ClaudeMessage) => {
      const blocks = getContentBlocksUtil(message, normalizeBlocks, localizeMessage);
      // Inject attachment blocks from persistent storage: backend messages lack attachment blocks, so we restore them using metadata saved at send time
      if (message.type === 'user' && !blocks.some(b => b.type === 'attachment')) {
        const meta = sentAttachmentsRef.current.get(message.content || '');
        if (meta && meta.length > 0) {
          const attachmentBlocks: ClaudeContentBlock[] = meta.map(a => ({
            type: 'attachment' as const,
            fileName: a.fileName,
            mediaType: a.mediaType,
          }));
          return [...attachmentBlocks, ...blocks];
        }
      }
      return blocks;
    },
    [normalizeBlocks, localizeMessage]
  );

  // Merge consecutive assistant messages to fix style inconsistencies in history
  const mergedMessages = useMemo(() => {
    const visible: ClaudeMessage[] = [];
    for (const message of messages) {
      if (shouldShowMessageCached(message)) {
        visible.push(message);
      }
    }
    const result = mergeConsecutiveAssistantMessages(visible, normalizeBlocks, mergedAssistantMessageCache.current);
    return result;
  }, [messages, shouldShowMessageCached, normalizeBlocks]);

  // Rewind handlers
  const {
    handleRewindConfirm,
    handleRewindCancel,
    handleOpenRewindSelectDialog,
    handleRewindSelect,
    handleRewindSelectCancel,
  } = useRewindHandlers({
    t,
    addToast,
    currentSessionId,
    mergedMessages,
    getMessageText,
    setCurrentRewindRequest,
    setRewindDialogOpen,
    setRewindSelectDialogOpen,
    setIsRewinding,
    isRewinding,
  });

  // Extract the latest todos from messages for global TodoPanel display
  const globalTodos = useMemo(() => {
    // Traverse backwards to find the latest todowrite tool call
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant') continue;

      const blocks = getContentBlocks(msg);
      // Traverse blocks backwards to find the latest todowrite
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j];
        if (
          block.type === 'tool_use' &&
          block.name?.toLowerCase() === 'todowrite' &&
          Array.isArray((block.input as { todos?: TodoItem[] })?.todos)
        ) {
          return (block.input as { todos: TodoItem[] }).todos;
        }
      }
    }
    return [];
  }, [messages]);

  const canRewindFromMessageIndex = (userMessageIndex: number) => {
    if (userMessageIndex < 0 || userMessageIndex >= mergedMessages.length) {
      return false;
    }

    const current = mergedMessages[userMessageIndex];
    if (current.type !== 'user') return false;
    if ((current.content || '').trim() === '[tool_result]') return false;
    const raw = current.raw;
    if (raw && typeof raw !== 'string') {
      const content = (raw as any).content ?? (raw as any).message?.content;
      if (Array.isArray(content) && content.some((block: any) => block && block.type === 'tool_result')) {
        return false;
      }
    }

    for (let i = userMessageIndex + 1; i < mergedMessages.length; i += 1) {
      const msg = mergedMessages[i];
      if (msg.type === 'user') {
        break;
      }
      const blocks = getContentBlocks(msg);
      for (const block of blocks) {
        if (block.type !== 'tool_use') {
          continue;
        }
        // Check if this is a file modification tool
        if (isToolName(block.name, FILE_MODIFY_TOOL_NAMES)) {
          return true;
        }
      }
    }

    return false;
  };

  // Calculate rewindable messages for the select dialog
  const rewindableMessages = useMemo((): RewindableMessage[] => {
    if (currentProvider !== 'claude') {
      return [];
    }

    const result: RewindableMessage[] = [];

    for (let i = 0; i < mergedMessages.length - 1; i++) {
      if (!canRewindFromMessageIndex(i)) {
        continue;
      }

      const message = mergedMessages[i];
      const content = message.content || getMessageText(message);
      const timestamp = message.timestamp ? formatTime(message.timestamp) : undefined;
      const messagesAfterCount = mergedMessages.length - i - 1;

      result.push({
        messageIndex: i,
        message,
        displayContent: content,
        timestamp,
        messagesAfterCount,
      });
    }

    return result;
  }, [mergedMessages, currentProvider]);

  // Use useRef to store latest messages, preventing child re-renders from findToolResult dependency changes
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const findToolResult = useCallback((toolUseId?: string, messageIndex?: number): ToolResultBlock | null => {
    if (!toolUseId || typeof messageIndex !== 'number') {
      return null;
    }

    const currentMessages = messagesRef.current;
    // Note: Search in the original messages array, not mergedMessages
    // because tool_result may be in filtered-out messages
    for (let i = 0; i < currentMessages.length; i += 1) {
      const candidate = currentMessages[i];
      const raw = candidate.raw;

      if (!raw || typeof raw === 'string') {
        continue;
      }
      // Compatible with both raw.content and raw.message.content
      const content = raw.content ?? raw.message?.content;

      if (!Array.isArray(content)) {
        continue;
      }

      const resultBlock = content.find(
        (block): block is ToolResultBlock =>
          Boolean(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId,
      );
      if (resultBlock) {
        return resultBlock;
      }
    }

    return null;
  }, []);

  // Extract file change summary from messages for StatusPanel display
  const fileChanges = useFileChanges({
    messages,
    getContentBlocks,
    findToolResult,
    startFromIndex: baseMessageIndex,
  });

  // Filter out processed files (Apply/Reject)
  const filteredFileChanges = useMemo(() => {
    if (processedFiles.length === 0) return fileChanges;
    return fileChanges.filter(fc => !processedFiles.includes(fc.filePath));
  }, [fileChanges, processedFiles]);

  // Callback after file undo success (triggered from StatusPanel)
  const handleUndoFile = useCallback((filePath: string) => {
    setProcessedFiles(prev => {
      if (prev.includes(filePath)) return prev;
      const newList = [...prev, filePath];

      // Persist to localStorage
      if (currentSessionId) {
        try {
          localStorage.setItem(
            `processed-files-${currentSessionId}`,
            JSON.stringify(newList)
          );
        } catch (e) {
          console.error('Failed to persist processed files:', e);
        }
      }

      return newList;
    });
  }, [currentSessionId]);

  // Callback after batch undo success (Discard All)
  const handleDiscardAll = useCallback(() => {
    // Add all currently displayed files to the processed list
    setProcessedFiles(prev => {
      const filesToAdd = filteredFileChanges.map(fc => fc.filePath);
      const newList = [...prev, ...filesToAdd.filter(f => !prev.includes(f))];

      // Persist to localStorage
      if (currentSessionId) {
        try {
          localStorage.setItem(
            `processed-files-${currentSessionId}`,
            JSON.stringify(newList)
          );
        } catch (e) {
          console.error('Failed to persist processed files:', e);
        }
      }

      return newList;
    });
  }, [filteredFileChanges, currentSessionId]);

  // Callback for Keep All - set current changes as the new baseline
  const handleKeepAll = useCallback(() => {
    // Set new base message index to current message count
    const newBaseIndex = messages.length;
    setBaseMessageIndex(newBaseIndex);
    // Clear processed files list
    setProcessedFiles([]);

    // Persist to localStorage (stored by sessionId)
    if (currentSessionId) {
      try {
        localStorage.setItem(`keep-all-base-${currentSessionId}`, String(newBaseIndex));
        // Also clear processed-files
        localStorage.removeItem(`processed-files-${currentSessionId}`);
      } catch (e) {
        console.error('Failed to persist Keep All state:', e);
      }
    }
  }, [messages.length, currentSessionId]);

  // Register window callbacks for editable diff operations from Java backend
  useEffect(() => {
    // Handle remove file from edits list (legacy callback, now uses handleDiffResult)
    // Kept for backward compatibility with older Java code paths
    window.handleRemoveFileFromEdits = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const filePath = data.filePath;
        if (filePath) {
          setProcessedFiles(prev => {
            if (prev.includes(filePath)) return prev;
            const newList = [...prev, filePath];

            // Persist to localStorage
            const sessionId = currentSessionIdRef.current;
            if (sessionId) {
              try {
                localStorage.setItem(
                  `processed-files-${sessionId}`,
                  JSON.stringify(newList)
                );
              } catch (e) {
                console.error('Failed to persist processed files:', e);
              }
            }

            return newList;
          });
        }
      } catch {
        // JSON parse failed, ignore
      }
    };

    // Handle interactive diff result (Apply/Reject from the new interactive diff view)
    window.handleDiffResult = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const { filePath, action, error } = data;
        // Note: 'content' is also available in data but not used here

        if (error) {
          console.error('[InteractiveDiff] Error:', error);
          return;
        }

        if (action === 'APPLY' || action === 'REJECT') {
          // Both APPLY and REJECT mark the file as processed (user has taken action)
          setProcessedFiles(prev => {
            if (prev.includes(filePath)) return prev;
            const newList = [...prev, filePath];

            // Persist to localStorage
            const sessionId = currentSessionIdRef.current;
            if (sessionId) {
              try {
                localStorage.setItem(
                  `processed-files-${sessionId}`,
                  JSON.stringify(newList)
                );
              } catch (e) {
                console.error('Failed to persist processed files:', e);
              }
            }

            return newList;
          });
          console.log(`[InteractiveDiff] ${action} changes to:`, filePath);
        }
        // DISMISS: Do nothing, file remains in list for later processing
      } catch {
        // JSON parse failed, ignore
      }
    };

    return () => {
      delete window.handleRemoveFileFromEdits;
      delete window.handleDiffResult;
    };
  }, []);

  // Restore/reset state on session switch, preventing state from being cleared during history loading
  useEffect(() => {
    // Reset processed files for new session (will be restored from localStorage below)
    setProcessedFiles([]);

    if (!currentSessionId) {
      setBaseMessageIndex(0);
      return;
    }

    // Cleanup old localStorage entries to prevent infinite growth
    // Keep only the most recent 50 sessions' data
    const MAX_STORED_SESSIONS = 50;
    try {
      // Clean up both processed-files and keep-all-base keys
      const keysToCheck = Object.keys(localStorage)
        .filter(k => k.startsWith('processed-files-') || k.startsWith('keep-all-base-'));
      if (keysToCheck.length > MAX_STORED_SESSIONS) {
        // Remove oldest entries (simple FIFO, not perfect but good enough)
        const toRemove = keysToCheck.slice(0, keysToCheck.length - MAX_STORED_SESSIONS);
        toRemove.forEach(k => localStorage.removeItem(k));
      }
    } catch {
      // Ignore cleanup errors
    }

    // Restore processed files from localStorage
    try {
      const savedProcessedFiles = localStorage.getItem(
        `processed-files-${currentSessionId}`
      );
      if (savedProcessedFiles) {
        const files = JSON.parse(savedProcessedFiles);
        if (Array.isArray(files)) {
          setProcessedFiles(files);
        }
      }
    } catch (e) {
      console.error('Failed to load processed files:', e);
    }

    // Restore Keep All base index
    try {
      const savedBaseIndex = localStorage.getItem(`keep-all-base-${currentSessionId}`);
      if (savedBaseIndex) {
        const index = parseInt(savedBaseIndex, 10);
        if (!isNaN(index) && index >= 0) {
          setBaseMessageIndex(index);
          return;
        }
      }
    } catch (e) {
      console.error('Failed to load Keep All state:', e);
    }

    setBaseMessageIndex(0);
  }, [currentSessionId]);

  // Extract subagent info from messages for StatusPanel display
  const subagents = useSubagents({
    messages,
    getContentBlocks,
    findToolResult,
  });

  // Auto-expand StatusPanel when there is content
  const hasStatusPanelContent = globalTodos.length > 0 || filteredFileChanges.length > 0 || subagents.length > 0;
  useEffect(() => {
    if (hasStatusPanelContent) {
      setStatusPanelExpanded(true);
    }
  }, [hasStatusPanelContent]);

  const sessionTitle = useMemo(() => {
    if (messages.length === 0) {
      return t('common.newSession');
    }
    const firstUserMessage = messages.find((message) => message.type === 'user');
    if (!firstUserMessage) {
      return t('common.newSession');
    }
    const text = getMessageText(firstUserMessage);
    return text.length > 15 ? `${text.substring(0, 15)}...` : text;
  }, [messages, t, getMessageText]);

  return (
    <>
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      <ChatHeader
        currentView={currentView}
        sessionTitle={sessionTitle}
        t={t}
        onBack={() => setCurrentView('chat')}
        onNewSession={createNewSession}
        onNewTab={() => sendBridgeEvent('create_new_tab')}
        onHistory={() => setCurrentView('history')}
        onSettings={() => {
          setSettingsInitialTab(undefined);
          setCurrentView('settings');
        }}
      />

      {currentView === 'settings' ? (
        <SettingsView
          onClose={() => setCurrentView('chat')}
          initialTab={settingsInitialTab}
          currentProvider={currentProvider}
          streamingEnabled={streamingEnabledSetting}
          onStreamingEnabledChange={handleStreamingEnabledChange}
          sendShortcut={sendShortcut}
          onSendShortcutChange={handleSendShortcutChange}
          autoOpenFileEnabled={autoOpenFileEnabled}
          onAutoOpenFileEnabledChange={handleAutoOpenFileEnabledChange}
        />
      ) : currentView === 'chat' ? (
        <>
          <div className="messages-container" ref={messagesContainerRef}>
          {messages.length === 0 && (
            <WelcomeScreen
              currentProvider={currentProvider}
              t={t}
              onProviderChange={handleProviderSelect}
            />
          )}

          <MessageList
            messages={mergedMessages}
            streamingActive={streamingActive}
            isThinking={isThinking}
            loading={loading}
            loadingStartTime={loadingStartTime}
            t={t}
            getMessageText={getMessageText}
            getContentBlocks={getContentBlocks}
            findToolResult={findToolResult}
            extractMarkdownContent={extractMarkdownContent}
            messagesEndRef={messagesEndRef}
          />
        </div>

        {/* Scroll control button */}
        <ScrollControl containerRef={messagesContainerRef} inputAreaRef={inputAreaRef} />
      </>
      ) : (
        <HistoryView
          historyData={historyData}
          currentProvider={currentProvider}
          onLoadSession={loadHistorySession}
          onDeleteSession={deleteHistorySession}
          onExportSession={exportHistorySession}
          onToggleFavorite={toggleFavoriteSession}
          onUpdateTitle={updateHistoryTitle}
        />
      )}

      {currentView === 'chat' && (
        <>
          <StatusPanelErrorBoundary>
            <StatusPanel
              todos={globalTodos}
              fileChanges={filteredFileChanges}
              subagents={subagents}
              expanded={statusPanelExpanded}
              isStreaming={streamingActive}
              onUndoFile={handleUndoFile}
              onDiscardAll={handleDiscardAll}
              onKeepAll={handleKeepAll}
            />
          </StatusPanelErrorBoundary>
          <div className="input-area" ref={inputAreaRef}>
          <ChatInputBox
            ref={chatInputRef}
            isLoading={loading}
            selectedModel={selectedModel}
            permissionMode={permissionMode}
            currentProvider={currentProvider}
            usagePercentage={usagePercentage}
            usageUsedTokens={usageUsedTokens}
            usageMaxTokens={usageMaxTokens}
            showUsage={true}
            alwaysThinkingEnabled={activeProviderConfig?.settingsConfig?.alwaysThinkingEnabled ?? claudeSettingsAlwaysThinkingEnabled}
            placeholder={sendShortcut === 'cmdEnter' ? t('chat.inputPlaceholderCmdEnter') : t('chat.inputPlaceholderEnter')}
            sdkInstalled={currentSdkInstalled}
            sdkStatusLoading={!sdkStatusLoaded}
            onInstallSdk={() => {
              setSettingsInitialTab('dependencies');
              setCurrentView('settings');
            }}
            // Performance optimization: Keep value for initial sync, but onInput is now debounced
            value={draftInput}
            onInput={setDraftInput}
            onSubmit={handleSubmit}
            onStop={interruptSession}
            onModeSelect={handleModeSelect}
            onModelSelect={handleModelSelect}
            onProviderSelect={handleProviderSelect}
            reasoningEffort={reasoningEffort}
            onReasoningChange={handleReasoningChange}
            onToggleThinking={handleToggleThinking}
            streamingEnabled={streamingEnabledSetting}
            onStreamingEnabledChange={handleStreamingEnabledChange}
            sendShortcut={sendShortcut}
            selectedAgent={selectedAgent}
            onAgentSelect={handleAgentSelect}
            activeFile={contextInfo?.file}
            selectedLines={contextInfo?.startLine !== undefined && contextInfo?.endLine !== undefined
              ? (contextInfo.startLine === contextInfo.endLine
                  ? `L${contextInfo.startLine}`
                  : `L${contextInfo.startLine}-${contextInfo.endLine}`)
              : undefined}
            onClearContext={() => setContextInfo(null)}
            onOpenAgentSettings={() => {
              setSettingsInitialTab('agents');
              setCurrentView('settings');
            }}
            onOpenPromptSettings={() => {
              setSettingsInitialTab('prompts');
              setCurrentView('settings');
            }}
            hasMessages={messages.length > 0}
            onRewind={handleOpenRewindSelectDialog}
            statusPanelExpanded={statusPanelExpanded}
            onToggleStatusPanel={() => setStatusPanelExpanded(!statusPanelExpanded)}
            addToast={addToast}
            messageQueue={messageQueue}
            onRemoveFromQueue={dequeueMessage}
          />
        </div>
        </>
      )}

      <div id="image-preview-root" />

      <ConfirmDialog
        isOpen={showNewSessionConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmNewSession')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={handleConfirmNewSession}
        onCancel={handleCancelNewSession}
      />

      <ConfirmDialog
        isOpen={showInterruptConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmInterrupt')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={handleConfirmInterrupt}
        onCancel={handleCancelInterrupt}
      />

      <PermissionDialog
        isOpen={permissionDialogOpen}
        request={currentPermissionRequest}
        onApprove={handlePermissionApprove}
        onSkip={handlePermissionSkip}
        onApproveAlways={handlePermissionApproveAlways}
      />

      <AskUserQuestionDialog
        isOpen={askUserQuestionDialogOpen}
        request={currentAskUserQuestionRequest}
        onSubmit={handleAskUserQuestionSubmit}
        onCancel={handleAskUserQuestionCancel}
      />

      <PlanApprovalDialog
        isOpen={planApprovalDialogOpen}
        request={currentPlanApprovalRequest}
        onApprove={handlePlanApprovalApprove}
        onReject={handlePlanApprovalReject}
      />

      <RewindSelectDialog
        isOpen={rewindSelectDialogOpen}
        rewindableMessages={rewindableMessages}
        onSelect={handleRewindSelect}
        onCancel={handleRewindSelectCancel}
      />

      <RewindDialog
        isOpen={rewindDialogOpen}
        request={currentRewindRequest}
        isLoading={isRewinding}
        onConfirm={handleRewindConfirm}
        onCancel={handleRewindCancel}
      />

      <ChangelogDialog
        isOpen={showChangelogDialog}
        onClose={handleCloseChangelog}
        entries={CHANGELOG_DATA}
      />
    </>
  );
};

export default App;
