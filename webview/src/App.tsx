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
import { TodoPanel } from './components/TodoPanel';
import { ToastContainer, type ToastMessage } from './components/Toast';
import { ScrollControl } from './components/ScrollControl';
import { extractMarkdownContent } from './utils/copyUtils';
import { ChatHeader } from './components/ChatHeader';
import { WelcomeScreen } from './components/WelcomeScreen';
import { MessageList, type MessageListHandle } from './components/MessageList';
import { FILE_MODIFY_TOOL_NAMES, isToolName } from './utils/toolConstants';
import { debugLog, debugError, debugWarn } from './utils/debugLogger';
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
  const { t, i18n } = useTranslation();

  // 使用 useMemo 创建稳定的 t 引用，只在语言变化时更新
  // 这避免了依赖 t 的 useCallback/useMemo 在每次渲染时失效
  // 注意：直接使用 t 而不是包装函数，以保持正确的类型
  const stableT = useMemo(() => t, [i18n.language]);

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
  // IDE 主题状态 - 优先使用 Java 注入的初始主题
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    // 检查 Java 是否注入了初始主题
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

  // Virtuoso 内部滚动容器 ref（用于 ScrollControl）
  const virtuosoScrollerRef = useRef<HTMLElement | null>(null);
  const handleScrollerRef = useCallback((scroller: HTMLElement | Window | null) => {
    // Virtuoso 可能返回 Window 或 HTMLElement，我们只需要 HTMLElement
    if (scroller && scroller !== window) {
      virtuosoScrollerRef.current = scroller as HTMLElement;
    }
  }, []);

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
  // MessageList ref for virtualized scroll control
  const messageListRef = useRef<MessageListHandle>(null);
  // Keep draftInput for backward compatibility (still used in some places)
  // but now it's updated via debounced callback, not on every keystroke
  const [draftInput, setDraftInput] = useState('');

  // ChatInputBox 相关状态
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
  // 🔧 流式传输开关状态（同步设置页面）
  const [streamingEnabledSetting, setStreamingEnabledSetting] = useState(true);
  // 发送快捷键设置
  const [sendShortcut, setSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');

  // 🔧 SDK 安装状态（用于在未安装时禁止提问）
  const [sdkStatus, setSdkStatus] = useState<Record<string, { installed?: boolean; status?: string }>>({});
  const [sdkStatusLoaded, setSdkStatusLoaded] = useState(false); // 标记 SDK 状态是否已从后端加载

  // 使用 useRef 存储最新的 provider 值，避免回调中的闭包问题
  const currentProviderRef = useRef(currentProvider);
  useEffect(() => {
    currentProviderRef.current = currentProvider;
  }, [currentProvider]);

  // 切换回 chat 视图时滚动到底部
  useEffect(() => {
    if (currentView === 'chat') {
      // 使用 setTimeout 确保视图完全渲染后再滚动
      const timer = setTimeout(() => {
        messageListRef.current?.scrollToBottom();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [currentView]);

  // Context state (active file and selection) - 保留用于 ContextBar 显示
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  // 根据当前提供商选择显示的模型
  const selectedModel = currentProvider === 'codex' ? selectedCodexModel : selectedClaudeModel;

  // 🔧 根据当前提供商判断对应的 SDK 是否已安装
  const currentSdkInstalled = (() => {
    // 状态未加载时，返回 false（显示加载中或未安装提示）
    if (!sdkStatusLoaded) return false;
    // 提供商 -> SDK 映射
    const providerToSdk: Record<string, string> = {
      claude: 'claude-sdk',
      anthropic: 'claude-sdk',
      bedrock: 'claude-sdk',
      codex: 'codex-sdk',
      openai: 'codex-sdk',
    };
    const sdkId = providerToSdk[currentProvider] || 'claude-sdk';
    const status = sdkStatus[sdkId];
    // 检查 status 字段（优先）或 installed 字段
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

  // 初始化主题和字体缩放
  useEffect(() => {
    debugLog('[Frontend][Theme] Initializing theme system');

    // 注册 IDE 主题接收回调
    window.onIdeThemeReceived = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        debugLog('[Frontend][Theme] IDE theme received:', {
          raw: themeData,
          resolved: theme,
          currentSetting: localStorage.getItem('theme')
        });
        setIdeTheme(theme);
      } catch (e) {
        debugError('[Frontend][Theme] Failed to parse IDE theme response:', e, 'Raw:', jsonStr);
      }
    };

    // 监听 IDE 主题变化（当用户在 IDE 中切换主题时）
    window.onIdeThemeChanged = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        debugLog('[Frontend][Theme] IDE theme changed:', {
          raw: themeData,
          resolved: theme,
          currentSetting: localStorage.getItem('theme')
        });
        setIdeTheme(theme);
      } catch (e) {
        debugError('[Frontend][Theme] Failed to parse IDE theme change:', e, 'Raw:', jsonStr);
      }
    };

    // 初始化字体缩放
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 3; // 默认档位 3 (100%)
    const fontSizeLevel = (level >= 1 && level <= 6) ? level : 3;

    // 将档位映射到缩放比例
    const fontSizeMap: Record<number, number> = {
      1: 0.8,   // 80%
      2: 0.9,   // 90%
      3: 1.0,   // 100% (默认)
      4: 1.1,   // 110%
      5: 1.2,   // 120%
      6: 1.4,   // 140%
    };
    const scale = fontSizeMap[fontSizeLevel] || 1.0;
    document.documentElement.style.setProperty('--font-scale', scale.toString());

    // 先应用用户明确选择的主题（light/dark），跟随 IDE 的情况等 ideTheme 更新后再处理
    const savedTheme = localStorage.getItem('theme');
    debugLog('[Frontend][Theme] Saved theme preference:', savedTheme);

    // 检查是否有 Java 注入的初始主题
    const injectedTheme = (window as any).__INITIAL_IDE_THEME__;
    debugLog('[Frontend][Theme] Injected IDE theme:', injectedTheme);

    // 注意：data-theme 已由 index.html 的内联脚本设置，这里只需要检查日志
    if (savedTheme === 'light' || savedTheme === 'dark') {
      debugLog('[Frontend][Theme] User explicit theme:', savedTheme);
    } else if (injectedTheme === 'light' || injectedTheme === 'dark') {
      debugLog('[Frontend][Theme] Follow IDE mode with injected theme:', injectedTheme);
    } else {
      debugLog('[Frontend][Theme] Follow IDE mode detected, will wait for IDE theme');
    }

    // 请求 IDE 主题（带重试机制）- 仍然需要，用于处理动态主题变化
    let retryCount = 0;
    const MAX_RETRIES = 20; // 最多重试 20 次 (2 秒)

    const requestIdeTheme = () => {
      if (window.sendToJava) {
        debugLog('[Frontend][Theme] Requesting IDE theme from backend');
        window.sendToJava('get_ide_theme:');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          debugLog(`[Frontend][Theme] Bridge not ready, retrying (${retryCount}/${MAX_RETRIES})...`);
          setTimeout(requestIdeTheme, 100);
        } else {
          debugError('[Frontend][Theme] Failed to request IDE theme: bridge not available after', MAX_RETRIES, 'retries');
          // 如果是 Follow IDE 模式且无法获取 IDE 主题，使用注入的主题或 dark 作为 fallback
          if (savedTheme === null || savedTheme === 'system') {
            const fallback = injectedTheme || 'dark';
            debugWarn('[Frontend][Theme] Fallback to theme:', fallback);
            setIdeTheme(fallback as 'light' | 'dark');
          }
        }
      }
    };

    // 延迟 100ms 开始请求，给 bridge 初始化时间
    setTimeout(requestIdeTheme, 100);
  }, []);

  // 当 IDE 主题变化时，重新应用主题（如果用户选择了"跟随 IDE"）
  // 这个 effect 也处理初始加载时的主题设置
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');

    debugLog('[Frontend][Theme] ideTheme effect triggered:', {
      ideTheme,
      savedTheme,
      currentDataTheme: document.documentElement.getAttribute('data-theme')
    });

    // 只有在 ideTheme 已加载后才处理
    if (ideTheme === null) {
      debugLog('[Frontend][Theme] IDE theme not loaded yet, waiting...');
      return;
    }

    // 如果用户选择了 "Follow IDE" 模式
    if (savedTheme === null || savedTheme === 'system') {
      debugLog('[Frontend][Theme] Applying IDE theme:', ideTheme);
      document.documentElement.setAttribute('data-theme', ideTheme);
    } else {
      debugLog('[Frontend][Theme] User has explicit theme preference:', savedTheme, '- not applying IDE theme');
    }
  }, [ideTheme]);

  // 从 LocalStorage 加载模型选择状态，并同步到后端
  useEffect(() => {
    try {
      const saved = localStorage.getItem('model-selection-state');
      let restoredProvider = 'claude';
      let restoredClaudeModel = CLAUDE_MODELS[0].id;
      let restoredCodexModel = CODEX_MODELS[0].id;
      let initialPermissionMode: PermissionMode = 'bypassPermissions';

      if (saved) {
        const state = JSON.parse(saved);

        // 验证并恢复提供商
        if (['claude', 'codex'].includes(state.provider)) {
          restoredProvider = state.provider;
          setCurrentProvider(state.provider);
          if (state.provider === 'codex') {
            initialPermissionMode = 'bypassPermissions';
          }
        }

        // 验证并恢复 Claude 模型
        if (CLAUDE_MODELS.find(m => m.id === state.claudeModel)) {
          restoredClaudeModel = state.claudeModel;
          setSelectedClaudeModel(state.claudeModel);
        }

        // 验证并恢复 Codex 模型
        if (CODEX_MODELS.find(m => m.id === state.codexModel)) {
          restoredCodexModel = state.codexModel;
          setSelectedCodexModel(state.codexModel);
        }
      }

      setPermissionMode(initialPermissionMode);

      // 初始化时同步模型状态到后端，确保前后端一致
      let syncRetryCount = 0;
      const MAX_SYNC_RETRIES = 30; // 最多重试30次（3秒）

      const syncToBackend = () => {
        if (window.sendToJava) {
          // 先同步 provider
          sendBridgeEvent('set_provider', restoredProvider);
          // 再同步对应的模型
          const modelToSync = restoredProvider === 'codex' ? restoredCodexModel : restoredClaudeModel;
          sendBridgeEvent('set_model', modelToSync);
          sendBridgeEvent('set_mode', initialPermissionMode);
          debugLog('[Frontend] Synced model state to backend:', { provider: restoredProvider, model: modelToSync });
        } else {
          // 如果 sendToJava 还没准备好，稍后重试
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          } else {
            debugWarn('[Frontend] Failed to sync model state to backend: bridge not available after', MAX_SYNC_RETRIES, 'retries');
          }
        }
      };
      // 延迟同步，等待 bridge 准备好
      setTimeout(syncToBackend, 200);
    } catch (error) {
      debugError('Failed to load model selection state:', error);
    }
  }, []);

  // 保存模型选择状态到 LocalStorage
  useEffect(() => {
    try {
      localStorage.setItem('model-selection-state', JSON.stringify({
        provider: currentProvider,
        claudeModel: selectedClaudeModel,
        codexModel: selectedCodexModel,
      }));
    } catch (error) {
      debugError('Failed to save model selection state:', error);
    }
  }, [currentProvider, selectedClaudeModel, selectedCodexModel]);

  // 加载选中的智能体
  useEffect(() => {
    let retryCount = 0;
    const MAX_RETRIES = 10; // 减少到10次，总共1秒
    let timeoutId: number | undefined;

    const loadSelectedAgent = () => {
      if (window.sendToJava) {
        sendBridgeEvent('get_selected_agent');
        debugLog('[Frontend] Requested selected agent');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          timeoutId = window.setTimeout(loadSelectedAgent, 100);
        } else {
          debugWarn('[Frontend] Failed to load selected agent: bridge not available after', MAX_RETRIES, 'retries');
          // 即使加载失败，也不影响其他功能的使用
        }
      }
    };

    timeoutId = window.setTimeout(loadSelectedAgent, 200); // 减少初始延迟到200ms

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
   * 处理消息发送（来自 ChatInputBox）
   */
  const handleSubmit = (content: string, attachments?: Attachment[]) => {
    // Remove zero-width spaces and other invisible characters
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!text && !hasAttachments) {
      return;
    }
    if (loading) {
      return;
    }

    // 🔧 防御性校验：即使输入框侧 gating 失效，也不能在 SDK 状态未知/未安装时发送
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

    // 🔧 检查未实现的斜杠命令
    // Check for unimplemented slash commands
    if (text.startsWith('/')) {
      const command = text.split(/\s+/)[0].toLowerCase();
      const unimplementedCommands = ['/plugin', '/plugins'];
      if (unimplementedCommands.includes(command)) {
        // 添加用户消息
        const userMessage: ClaudeMessage = {
          type: 'user',
          content: text,
          timestamp: new Date().toISOString(),
        };
        // 添加提示消息
        const assistantMessage: ClaudeMessage = {
          type: 'assistant',
          content: t('chat.commandNotImplemented', { command }),
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMessage, assistantMessage]);
        return;
      }
    }

    // 构建用户消息的内容块（用于前端显示）
    const userContentBlocks: ClaudeContentBlock[] = [];

    if (hasAttachments) {
      // 添加图片块
      for (const att of attachments || []) {
        if (att.mediaType?.startsWith('image/')) {
          userContentBlocks.push({
            type: 'image',
            src: `data:${att.mediaType};base64,${att.data}`,
            mediaType: att.mediaType,
          });
        } else {
          // Non-image attachment - display file name
          userContentBlocks.push({
            type: 'text',
            text: t('chat.attachmentFile', { fileName: att.fileName }),
          });
        }
      }
    }

    // 添加文本块
    if (text) {
      userContentBlocks.push({ type: 'text', text });
    } else if (userContentBlocks.length === 0) {
      // 如果既没有附件也没有文本，不发送
      return;
    }

    // Add user message immediately on frontend (includes image preview)
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: text || (hasAttachments ? t('chat.attachmentsUploaded') : ''),
      timestamp: new Date().toISOString(),
      isOptimistic: true, // 标记为乐观更新消息
      raw: {
        message: {
          content: userContentBlocks,
        },
      },
    };
    setMessages((prev) => [...prev, userMessage]);

    // 【FIX】立即设置 loading 状态，避免与后端回调的竞态条件
    // 第二次发送消息时，后端的 channelId 已存在，响应可能非常快
    // 如果等待后端回调设置 loading，可能会被 message_end 的 loading=false 覆盖
    setLoading(true);
    setLoadingStartTime(Date.now());

    // 发送消息后强制滚动到底部，确保用户能看到"正在生成响应"提示和新内容
    isUserAtBottomRef.current = true;
    requestAnimationFrame(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    });

    // 【FIX】在发送消息前，强制同步 provider 设置，确保后端使用正确的 SDK
    debugLog('[DEBUG] Current provider before send:', currentProvider);
    sendBridgeEvent('set_provider', currentProvider);

    // 【FIX】构建智能体信息，随消息一起发送，确保每个标签页使用自己选择的智能体
    const agentInfo = selectedAgent ? {
      id: selectedAgent.id,
      name: selectedAgent.name,
      prompt: selectedAgent.prompt,
    } : null;

    // 【FIX】提取文件标签信息，用于 Codex 上下文注入
    // Extract file tags for Codex context injection
    const fileTags = chatInputRef.current?.getFileTags() ?? [];
    const fileTagsInfo = fileTags.length > 0 ? fileTags.map(tag => ({
      displayPath: tag.displayPath,
      absolutePath: tag.absolutePath,
    })) : null;

    // 发送消息（智能体提示词由前端传递，不依赖后端全局设置）
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
        debugError('[Frontend] Failed to serialize attachments payload', error);
        // Fallback: send message with agent info and file tags
        const fallbackPayload = JSON.stringify({ text, agent: agentInfo, fileTags: fileTagsInfo });
        sendBridgeEvent('send_message', fallbackPayload);
      }
    } else {
      // 【FIX】将消息、智能体信息和文件标签打包成 JSON 发送
      const payload = JSON.stringify({ text, agent: agentInfo, fileTags: fileTagsInfo });
      sendBridgeEvent('send_message', payload);
    }
  };

  /**
   * 处理模式选择
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
   * 处理模型选择
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
   * 处理提供商选择
   * 切换 provider 时清空消息和输入框（类似新建会话）
   */
  const handleProviderSelect = (providerId: string) => {
    // 清空消息列表（类似新建会话）
    setMessages([]);
    // 清空输入框
    chatInputRef.current?.clear();

    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);
    const modeToSet = providerId === 'codex' ? 'bypassPermissions' : claudePermissionMode;
    setPermissionMode(modeToSet);
    sendBridgeEvent('set_mode', modeToSet);

    // 切换 provider 时,同时发送对应的模型
    const newModel = providerId === 'codex' ? selectedCodexModel : selectedClaudeModel;
    sendBridgeEvent('set_model', newModel);
  };

  /**
   * 处理思考深度选择 (Codex only)
   */
  const handleReasoningChange = (effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  };

  /**
   * 处理智能体选择
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
   * 处理思考模式切换
   */
  const handleToggleThinking = (enabled: boolean) => {
    if (!activeProviderConfig) {
      setClaudeSettingsAlwaysThinkingEnabled(enabled);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    // 更新本地状态（乐观更新）
    setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled
      }
    } : null);

    // 发送更新到后端
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
   * 处理流式传输开关切换
   */
  const handleStreamingEnabledChange = useCallback((enabled: boolean) => {
    setStreamingEnabledSetting(enabled);
    const payload = { streamingEnabled: enabled };
    sendBridgeEvent('set_streaming_enabled', JSON.stringify(payload));
    addToast(enabled ? t('settings.basic.streaming.enabled') : t('settings.basic.streaming.disabled'), 'success');
  }, [t, addToast]);

  /**
   * 处理发送快捷键变更
   */
  const handleSendShortcutChange = useCallback((shortcut: 'enter' | 'cmdEnter') => {
    setSendShortcut(shortcut);
    const payload = { sendShortcut: shortcut };
    sendBridgeEvent('set_send_shortcut', JSON.stringify(payload));
  }, []);

  const interruptSession = () => {
    // FIX: 立即重置前端状态，不等待后端回调
    // 这样可以让用户立即看到停止效果
    setLoading(false);
    setLoadingStartTime(null);
    setStreamingActive(false);
    isStreamingRef.current = false;

    sendBridgeEvent('interrupt_session');
  };

  // Message utility functions (use imported utilities with bound dependencies)
  // 使用 stableT 替代 t，确保在语言不变时 localizeMessage 引用稳定
  const localizeMessage = useMemo(() => createLocalizeMessage(stableT), [stableT]);

  // Cache for normalizeBlocks to avoid re-parsing unchanged messages
  const normalizeBlocksCache = useRef(new WeakMap<object, ClaudeContentBlock[]>());
  const shouldShowMessageCache = useRef(new WeakMap<object, boolean>());
  const mergedAssistantMessageCache = useRef(new Map<string, { source: ClaudeMessage[]; merged: ClaudeMessage }>());

  // 缓存大小限制常量
  const MERGED_CACHE_MAX_SIZE = 500;

  // Clear cache when dependencies change
  // 使用 stableT 替代 t，避免语言不变时不必要的缓存清除
  useEffect(() => {
    normalizeBlocksCache.current = new WeakMap();
    shouldShowMessageCache.current = new WeakMap();
    mergedAssistantMessageCache.current = new Map();
  }, [localizeMessage, stableT, currentSessionId]);

  // 缓存清理：当 mergedAssistantMessageCache 超过限制 20% 时，删除最早的条目
  // 使用 20% 缓冲区减少清理频率，避免每次消息变化都触发清理
  const limitMergedCache = useCallback(() => {
    const cache = mergedAssistantMessageCache.current;
    const cleanupThreshold = Math.floor(MERGED_CACHE_MAX_SIZE * 1.2);
    if (cache.size > cleanupThreshold) {
      // Map 保持插入顺序，删除最早插入的条目
      const keysToDelete = Array.from(cache.keys()).slice(0, cache.size - MERGED_CACHE_MAX_SIZE);
      for (const key of keysToDelete) {
        cache.delete(key);
      }
    }
  }, []);

  const normalizeBlocks = useCallback(
    (raw?: ClaudeRawMessage | string) => {
      if (!raw) return null;
      if (typeof raw === 'object') {
        const cache = normalizeBlocksCache.current;
        if (cache.has(raw)) {
          return cache.get(raw)!;
        }
        const result = normalizeBlocksUtil(raw, localizeMessage, stableT);
        if (result) {
          cache.set(raw, result);
        }
        return result;
      }
      return normalizeBlocksUtil(raw, localizeMessage, stableT);
    },
    [localizeMessage, stableT]
  );

  const getMessageText = useCallback(
    (message: ClaudeMessage) => getMessageTextUtil(message, localizeMessage, stableT),
    [localizeMessage, stableT]
  );

  const shouldShowMessage = useCallback(
    (message: ClaudeMessage) => shouldShowMessageUtil(message, getMessageText, normalizeBlocks, stableT),
    [getMessageText, normalizeBlocks, stableT]
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
    (message: ClaudeMessage) => getContentBlocksUtil(message, normalizeBlocks, localizeMessage),
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
    // 限制缓存大小，避免内存泄漏
    limitMergedCache();
    return result;
  }, [messages, shouldShowMessageCached, normalizeBlocks, limitMergedCache]);

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

  // 从消息中提取最新的 todos 用于全局 TodoPanel 显示
  // 性能优化：只扫描最后50条消息，因为 todowrite 通常出现在最近的对话中
  const globalTodos = useMemo(() => {
    const SCAN_LIMIT = 50;
    const startIndex = Math.max(0, messages.length - SCAN_LIMIT);

    // 从后往前遍历，找到最新的 todowrite 工具调用
    for (let i = messages.length - 1; i >= startIndex; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant') continue;

      const blocks = getContentBlocks(msg);
      // 从后往前遍历 blocks，找到最新的 todowrite
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
  }, [messages, getContentBlocks]);

  // 预计算可 rewind 的用户消息索引集合
  // 性能优化：O(n²) → O(n)，通过单次遍历预计算替代每个消息的重复遍历
  const rewindableIndicesSet = useMemo(() => {
    const indices = new Set<number>();
    if (currentProvider !== 'claude' || mergedMessages.length === 0) {
      return indices;
    }

    // 从后向前遍历，标记哪些用户消息后面有文件修改操作
    let hasFileModifyAfter = false;
    let lastUserIndex = -1;

    for (let i = mergedMessages.length - 1; i >= 0; i--) {
      const msg = mergedMessages[i];

      if (msg.type === 'user') {
        // 遇到用户消息时，检查其后是否有文件修改
        if (hasFileModifyAfter && lastUserIndex !== i) {
          // 还需要检查这条用户消息是否是 tool_result
          const content = (msg.content || '').trim();
          if (content !== '[tool_result]') {
            const raw = msg.raw;
            let isToolResult = false;
            if (raw && typeof raw !== 'string') {
              const rawContent = (raw as any).content ?? (raw as any).message?.content;
              if (Array.isArray(rawContent) && rawContent.some((block: any) => block && block.type === 'tool_result')) {
                isToolResult = true;
              }
            }
            if (!isToolResult) {
              indices.add(i);
            }
          }
        }
        // 重置状态，开始检测这条用户消息之前的区间
        hasFileModifyAfter = false;
        lastUserIndex = i;
      } else if (msg.type === 'assistant') {
        // 检查 assistant 消息中是否有文件修改工具
        const blocks = getContentBlocks(msg);
        for (const block of blocks) {
          if (block.type === 'tool_use' && isToolName(block.name, FILE_MODIFY_TOOL_NAMES)) {
            hasFileModifyAfter = true;
            break;
          }
        }
      }
    }

    return indices;
  }, [mergedMessages, currentProvider, getContentBlocks]);

  // Calculate rewindable messages for the select dialog
  // 使用预计算的索引集合，避免重复遍历
  const rewindableMessages = useMemo((): RewindableMessage[] => {
    if (currentProvider !== 'claude') {
      return [];
    }

    const result: RewindableMessage[] = [];

    // 只遍历预计算的可 rewind 索引
    for (const i of rewindableIndicesSet) {
      if (i >= mergedMessages.length - 1) continue;

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

    // 按索引排序，确保顺序一致
    result.sort((a, b) => a.messageIndex - b.messageIndex);

    return result;
  }, [mergedMessages, currentProvider, rewindableIndicesSet, getMessageText]);

  // 使用 useRef 存储最新的 messages，避免 findToolResult 依赖变化导致子组件重渲染
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const findToolResult = useCallback((toolUseId?: string, messageIndex?: number): ToolResultBlock | null => {
    if (!toolUseId || typeof messageIndex !== 'number') {
      return null;
    }

    const currentMessages = messagesRef.current;
    // 注意：在原始 messages 数组中查找，而不是 mergedMessages
    // 因为 tool_result 可能在被过滤掉的消息中
    for (let i = 0; i < currentMessages.length; i += 1) {
      const candidate = currentMessages[i];
      const raw = candidate.raw;

      if (!raw || typeof raw === 'string') {
        continue;
      }
      // 兼容 raw.content 和 raw.message.content
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
  }, [messages, t]);

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
            ref={messageListRef}
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
            onAtBottomStateChange={(atBottom) => {
              isUserAtBottomRef.current = atBottom;
            }}
            onScrollerRef={handleScrollerRef}
          />
        </div>

        {/* 滚动控制按钮 - 使用 Virtuoso 内部滚动容器和 API */}
        <ScrollControl
          containerRef={virtuosoScrollerRef}
          inputAreaRef={inputAreaRef}
          messageListRef={messageListRef}
        />
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
          {globalTodos.length > 0 && <TodoPanel todos={globalTodos} isStreaming={streamingActive || loading} />}
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
            hasMessages={messages.length > 0}
            onRewind={handleOpenRewindSelectDialog}
            addToast={addToast}
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
    </>
  );
};

export default App;
