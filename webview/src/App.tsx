import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownBlock from './components/MarkdownBlock';
import CollapsibleTextBlock from './components/CollapsibleTextBlock';
import HistoryView from './components/history/HistoryView';
import SettingsView from './components/settings';
import { BlinkingLogo } from './components/BlinkingLogo';
import { AnimatedText } from './components/AnimatedText';
import type { SettingsTab } from './components/settings/SettingsSidebar';
import ConfirmDialog from './components/ConfirmDialog';
import PermissionDialog, { type PermissionRequest } from './components/PermissionDialog';
import AskUserQuestionDialog, { type AskUserQuestionRequest } from './components/AskUserQuestionDialog';
import RewindDialog, { type RewindRequest } from './components/RewindDialog';
import RewindSelectDialog, { type RewindableMessage } from './components/RewindSelectDialog';
import { rewindFiles } from './utils/bridge';
import { ChatInputBox } from './components/ChatInputBox';
import { CLAUDE_MODELS, CODEX_MODELS } from './components/ChatInputBox/types';
import type { Attachment, PermissionMode, SelectedAgent } from './components/ChatInputBox/types';
import { setupSlashCommandsCallback, resetSlashCommandsState, resetFileReferenceState } from './components/ChatInputBox/providers';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  ReadToolBlock,
  TaskExecutionBlock,
  TodoListBlock,
} from './components/toolBlocks';
import { BackIcon } from './components/Icons';
import { ToastContainer, type ToastMessage } from './components/Toast';
import WaitingIndicator from './components/WaitingIndicator';
import { ScrollControl } from './components/ScrollControl';
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

const isTruthy = (value: unknown) => value === true || value === 'true';

const sendBridgeMessage = (event: string, payload = '') => {
  if (window.sendToJava) {
    const message = `${event}:${payload}`;
    // 对权限相关消息添加详细日志
    if (event.includes('permission')) {
      console.log('[PERM_DEBUG][BRIDGE] Sending to Java:', message);
    }
    window.sendToJava(message);
  } else {
    console.warn('[Frontend] sendToJava is not ready yet');
  }
};

const formatTime = (timestamp?: string) => {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) {
    return '';
  }
};

const App = () => {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [_status, setStatus] = useState(DEFAULT_STATUS); // Internal state, displayed via toast
  const [loading, setLoading] = useState(false);
  const [loadingStartTime, setLoadingStartTime] = useState<number | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [streamingActive, setStreamingActive] = useState(false);
  const [currentView, setCurrentView] = useState<ViewMode>('chat');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  const [historyData, setHistoryData] = useState<HistoryData | null>(null);
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [showInterruptConfirm, setShowInterruptConfirm] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // 输入框草稿内容（页面切换时保持）
  const [draftInput, setDraftInput] = useState('');
  // 标志位：是否抑制下一次 updateStatus 触发的 toast（用于删除当前会话后自动创建新会话的场景）
  const suppressNextStatusToastRef = useRef(false);

  // 权限弹窗状态
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PermissionRequest | null>(null);
  const permissionDialogOpenRef = useRef(false);
  const currentPermissionRequestRef = useRef<PermissionRequest | null>(null);
  const pendingPermissionRequestsRef = useRef<PermissionRequest[]>([]);

  // AskUserQuestion 弹窗状态
  const [askUserQuestionDialogOpen, setAskUserQuestionDialogOpen] = useState(false);
  const [currentAskUserQuestionRequest, setCurrentAskUserQuestionRequest] = useState<AskUserQuestionRequest | null>(null);
  const askUserQuestionDialogOpenRef = useRef(false);
  const currentAskUserQuestionRequestRef = useRef<AskUserQuestionRequest | null>(null);
  const pendingAskUserQuestionRequestsRef = useRef<AskUserQuestionRequest[]>([]);

  // Rewind 弹窗状态
  const [rewindDialogOpen, setRewindDialogOpen] = useState(false);
  const [currentRewindRequest, setCurrentRewindRequest] = useState<RewindRequest | null>(null);
  const [isRewinding, setIsRewinding] = useState(false);
  // Rewind 选择弹窗状态
  const [rewindSelectDialogOpen, setRewindSelectDialogOpen] = useState(false);

  // ChatInputBox 相关状态
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [selectedClaudeModel, setSelectedClaudeModel] = useState(CLAUDE_MODELS[0].id);
  const [selectedCodexModel, setSelectedCodexModel] = useState(CODEX_MODELS[0].id);
  const [claudePermissionMode, setClaudePermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [usagePercentage, setUsagePercentage] = useState(0);
  const [usageUsedTokens, setUsageUsedTokens] = useState<number | undefined>(undefined);
  const [usageMaxTokens, setUsageMaxTokens] = useState<number | undefined>(undefined);
  const [, setProviderConfigVersion] = useState(0);
  const [activeProviderConfig, setActiveProviderConfig] = useState<ProviderConfig | null>(null);
  const [claudeSettingsAlwaysThinkingEnabled, setClaudeSettingsAlwaysThinkingEnabled] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<SelectedAgent | null>(null);
  // 🔧 流式传输开关状态（同步设置页面）
  const [streamingEnabledSetting, setStreamingEnabledSetting] = useState(false);

  // 🔧 SDK 安装状态（用于在未安装时禁止提问）
  const [sdkStatus, setSdkStatus] = useState<Record<string, { installed?: boolean; status?: string }>>({});
  const [sdkStatusLoaded, setSdkStatusLoaded] = useState(false); // 标记 SDK 状态是否已从后端加载

  // 使用 useRef 存储最新的 provider 值，避免回调中的闭包问题
  const currentProviderRef = useRef(currentProvider);
  useEffect(() => {
    currentProviderRef.current = currentProvider;
  }, [currentProvider]);

  // Context state (active file and selection) - 保留用于 ContextBar 显示
  const [contextInfo, setContextInfo] = useState<{ file: string; startLine?: number; endLine?: number; raw: string } | null>(null);

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

  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputAreaRef = useRef<HTMLDivElement | null>(null);
  // 追踪用户是否在底部（用于判断是否需要自动滚动）
  const isUserAtBottomRef = useRef(true);
  // 追踪上次按下 ESC 的时间（用于双击 ESC 快捷键）
  const lastEscPressTimeRef = useRef<number>(0);

  // 🔧 流式传输状态
  // 使用 useRef 累积流式内容，避免频繁状态更新
  const streamingContentRef = useRef('');
  const isStreamingRef = useRef(false);
  const useBackendStreamingRenderRef = useRef(false);
  // 🔧 标记是否正在自动滚动（防止 scroll 事件误判）
  const isAutoScrollingRef = useRef(false);
  const autoExpandedThinkingKeysRef = useRef<Set<string>>(new Set());
  // 🔧 流式文本：按“阶段”切分（工具调用前/后等）
  const streamingTextSegmentsRef = useRef<string[]>([]);
  const activeTextSegmentIndexRef = useRef<number>(-1);
  // 🔧 流式思考：支持多段 thinking（例如工具调用前后多次思考）
  const streamingThinkingSegmentsRef = useRef<string[]>([]);
  const activeThinkingSegmentIndexRef = useRef<number>(-1);
  // 🔧 工具调用计数：用于识别“新 tool_use”边界，避免重复重置分段
  const seenToolUseCountRef = useRef(0);
  // 🔧 真正的节流控制（分离 content 和 thinking，避免互相干扰）
  // 🔧 追踪流式消息的索引，用于在 updateMessages 后仍能正确定位
  const streamingMessageIndexRef = useRef<number>(-1);
  const contentUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentUpdateRef = useRef(0);  // 上次 content 更新时间
  const lastThinkingUpdateRef = useRef(0); // 上次 thinking 更新时间
  const THROTTLE_INTERVAL = 50; // 50ms 节流间隔

  useEffect(() => {
    permissionDialogOpenRef.current = permissionDialogOpen;
    currentPermissionRequestRef.current = currentPermissionRequest;
  }, [permissionDialogOpen, currentPermissionRequest]);

  useEffect(() => {
    askUserQuestionDialogOpenRef.current = askUserQuestionDialogOpen;
    currentAskUserQuestionRequestRef.current = currentAskUserQuestionRequest;
  }, [askUserQuestionDialogOpen, currentAskUserQuestionRequest]);

  const openPermissionDialog = (request: PermissionRequest) => {
    currentPermissionRequestRef.current = request;
    permissionDialogOpenRef.current = true;
    setCurrentPermissionRequest(request);
    setPermissionDialogOpen(true);
  };

  const openAskUserQuestionDialog = (request: AskUserQuestionRequest) => {
    currentAskUserQuestionRequestRef.current = request;
    askUserQuestionDialogOpenRef.current = true;
    setCurrentAskUserQuestionRequest(request);
    setAskUserQuestionDialogOpen(true);
  };

  useEffect(() => {
    if (permissionDialogOpen) return;
    if (currentPermissionRequest) return;
    const next = pendingPermissionRequestsRef.current.shift();
    if (next) {
      openPermissionDialog(next);
    }
  }, [permissionDialogOpen, currentPermissionRequest]);

  useEffect(() => {
    if (askUserQuestionDialogOpen) return;
    if (currentAskUserQuestionRequest) return;
    const next = pendingAskUserQuestionRequestsRef.current.shift();
    if (next) {
      openAskUserQuestionDialog(next);
    }
  }, [askUserQuestionDialogOpen, currentAskUserQuestionRequest]);

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
    // 初始化主题
    const savedTheme = localStorage.getItem('theme');
    const theme = (savedTheme === 'light' || savedTheme === 'dark') ? savedTheme : 'dark';
    document.documentElement.setAttribute('data-theme', theme);

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
  }, []);

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
          sendBridgeMessage('set_provider', restoredProvider);
          // 再同步对应的模型
          const modelToSync = restoredProvider === 'codex' ? restoredCodexModel : restoredClaudeModel;
          sendBridgeMessage('set_model', modelToSync);
          sendBridgeMessage('set_mode', initialPermissionMode);
          console.log('[Frontend] Synced model state to backend:', { provider: restoredProvider, model: modelToSync });
        } else {
          // 如果 sendToJava 还没准备好，稍后重试
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          } else {
            console.warn('[Frontend] Failed to sync model state to backend: bridge not available after', MAX_SYNC_RETRIES, 'retries');
          }
        }
      };
      // 延迟同步，等待 bridge 准备好
      setTimeout(syncToBackend, 200);
    } catch (error) {
      console.error('Failed to load model selection state:', error);
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
      console.error('Failed to save model selection state:', error);
    }
  }, [currentProvider, selectedClaudeModel, selectedCodexModel]);

  // 加载选中的智能体
  useEffect(() => {
    let retryCount = 0;
    const MAX_RETRIES = 10; // 减少到10次，总共1秒
    let timeoutId: number | undefined;

    const loadSelectedAgent = () => {
      if (window.sendToJava) {
        sendBridgeMessage('get_selected_agent');
        console.log('[Frontend] Requested selected agent');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          timeoutId = window.setTimeout(loadSelectedAgent, 100);
        } else {
          console.warn('[Frontend] Failed to load selected agent: bridge not available after', MAX_RETRIES, 'retries');
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

  // Rewind 相关处理函数
  const handleRewindClick = (messageIndex: number, message: ClaudeMessage) => {
    if (!currentSessionId) {
      addToast(t('rewind.notAvailable'), 'warning');
      return;
    }

    const isToolResultOnlyUserMessage = (msg: ClaudeMessage) => {
      if (msg.type !== 'user') return false;
      if ((msg.content || '').trim() === '[tool_result]') return true;
      const raw = msg.raw;
      if (!raw || typeof raw === 'string') return false;
      const content = (raw as any).content ?? (raw as any).message?.content;
      if (!Array.isArray(content)) return false;
      return content.some((block: any) => block && block.type === 'tool_result');
    };

    let targetIndex = messageIndex;
    let targetMessage: ClaudeMessage = message;
    if (isToolResultOnlyUserMessage(message)) {
      for (let i = messageIndex - 1; i >= 0; i -= 1) {
        const candidate = mergedMessages[i];
        if (candidate.type !== 'user') continue;
        if (isToolResultOnlyUserMessage(candidate)) continue;
        targetIndex = i;
        targetMessage = candidate;
        break;
      }
    }

    const raw = targetMessage.raw;
    const uuid = typeof raw === 'object' ? (raw as any)?.uuid : undefined;
    if (!uuid) {
      addToast(t('rewind.notAvailable'), 'warning');
      console.warn('[Rewind] No UUID found in message:', targetMessage);
      return;
    }

    // Calculate messages after this one
    const messagesAfterCount = mergedMessages.length - targetIndex - 1;

    // Get display content for the dialog
    const content = targetMessage.content || getMessageText(targetMessage);
    const timestamp = targetMessage.timestamp ? formatTime(targetMessage.timestamp) : undefined;

    setCurrentRewindRequest({
      sessionId: currentSessionId,
      userMessageId: uuid,
      messageContent: content,
      messageTimestamp: timestamp,
      messagesAfterCount,
    });
    setRewindDialogOpen(true);
  };

  const handleRewindConfirm = (sessionId: string, userMessageId: string) => {
    console.log('[Rewind] Confirming rewind:', { sessionId, userMessageId });
    setIsRewinding(true);
    rewindFiles(sessionId, userMessageId);
  };

  const handleRewindCancel = () => {
    // Allow cancel even while rewinding (user can dismiss the dialog)
    if (isRewinding) {
      setIsRewinding(false);
    }
    setRewindDialogOpen(false);
    setCurrentRewindRequest(null);
  };

  // Open the rewind select dialog
  const handleOpenRewindSelectDialog = () => {
    setRewindSelectDialogOpen(true);
  };

  // Handle selection from the rewind select dialog
  const handleRewindSelect = (item: RewindableMessage) => {
    setRewindSelectDialogOpen(false);
    // Trigger the confirmation dialog
    handleRewindClick(item.messageIndex, item.message);
  };

  // Close the rewind select dialog
  const handleRewindSelectCancel = () => {
    setRewindSelectDialogOpen(false);
  };

  useEffect(() => {
    const findLastAssistantIndex = (list: ClaudeMessage[]) => {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i]?.type === 'assistant') return i;
      }
      return -1;
    };

    const extractRawBlocks = (raw: unknown): any[] => {
      if (!raw || typeof raw !== 'object') return [];
      const rawObj: any = raw;
      const blocks = rawObj.content ?? rawObj.message?.content;
      return Array.isArray(blocks) ? blocks : [];
    };

    const buildStreamingBlocks = (existingBlocks: any[]) => {
      const toolUseBlocks = existingBlocks.filter((b) => b?.type === 'tool_use');
      const otherBlocks = existingBlocks.filter(
        (b) => b && b.type !== 'text' && b.type !== 'thinking' && b.type !== 'tool_use',
      );

      const textSegments = streamingTextSegmentsRef.current;
      const thinkingSegments = streamingThinkingSegmentsRef.current;
      const phasesCount = Math.max(textSegments.length, thinkingSegments.length, toolUseBlocks.length + 1);

      const blocks: any[] = [];
      for (let phase = 0; phase < phasesCount; phase += 1) {
        const thinking = thinkingSegments[phase];
        if (typeof thinking === 'string' && thinking.length > 0) {
          // 🔧 更彻底地清理换行符：合并连续空白行，去除首尾空白
          const normalizedThinking = thinking
            .replace(/\r\n?/g, '\n')          // 统一换行符
            .replace(/\n[ \t]*\n+/g, '\n')    // 移除空白行（包含仅空格/Tab 的行）
            .replace(/^\n+/, '')              // 去除开头换行
            .replace(/\n+$/, '');             // 去除结尾换行
          if (normalizedThinking.length > 0) {
            blocks.push({ type: 'thinking', thinking: normalizedThinking });
          }
        }
        const text = textSegments[phase];
        if (typeof text === 'string' && text.length > 0) {
          blocks.push({ type: 'text', text });
        }
        if (phase < toolUseBlocks.length) {
          blocks.push(toolUseBlocks[phase]);
        }
      }

      if (otherBlocks.length > 0) {
        blocks.push(...otherBlocks);
      }
      return blocks;
    };

    const getOrCreateStreamingAssistantIndex = (list: ClaudeMessage[]) => {
      const currentIdx = streamingMessageIndexRef.current;
      if (currentIdx >= 0 && currentIdx < list.length && list[currentIdx]?.type === 'assistant') {
        return currentIdx;
      }
      const lastAssistantIdx = findLastAssistantIndex(list);
      if (lastAssistantIdx >= 0) {
        streamingMessageIndexRef.current = lastAssistantIdx;
        return lastAssistantIdx;
      }
      // 没有 assistant：追加一个占位
      streamingMessageIndexRef.current = list.length;
      list.push({
        type: 'assistant',
        content: '',
        isStreaming: true,
        timestamp: new Date().toISOString(),
        raw: { message: { content: [] } } as any,
      });
      return streamingMessageIndexRef.current;
    };

    const patchAssistantForStreaming = (assistant: ClaudeMessage) => {
      const existingRaw = (assistant.raw && typeof assistant.raw === 'object') ? (assistant.raw as any) : { message: { content: [] } };
      const existingBlocks = extractRawBlocks(existingRaw);
      const newBlocks = buildStreamingBlocks(existingBlocks);

      const rawPatched = existingRaw.message
        ? { ...existingRaw, message: { ...(existingRaw.message || {}), content: newBlocks } }
        : { ...existingRaw, content: newBlocks };

      return {
        ...assistant,
        content: streamingContentRef.current,
        raw: rawPatched,
        isStreaming: true,
      } as ClaudeMessage;
    };

    window.updateMessages = (json) => {
      // const timestamp = Date.now();
      // const sendTime = (window as any).__lastMessageSendTime;
      // if (sendTime) {
      //   console.log(`[Frontend][${timestamp}][PERF] updateMessages 收到响应，距发送 ${timestamp - sendTime}ms`);
      // }
      try {
        const parsed = JSON.parse(json) as ClaudeMessage[];

        // 🔧 禁用后端渲染模式，使用 onContentDelta 进行流式渲染
        // 这样可以确保 Markdown 在流式输出时正确渲染
        // if (isStreamingRef.current && currentProviderRef.current === 'claude') {
        //   const lastAssistantIdx = findLastAssistantIndex(parsed);
        //   if (lastAssistantIdx >= 0) {
        //     const rawBlocks = normalizeBlocks(parsed[lastAssistantIdx].raw) || [];
        //     const hasStreamingBlocks = rawBlocks.some(
        //       (block) => block?.type === 'text' || block?.type === 'thinking',
        //     );
        //     if (hasStreamingBlocks) {
        //       useBackendStreamingRenderRef.current = true;
        //       streamingMessageIndexRef.current = lastAssistantIdx;
        //     }
        //   }
        // }

        setMessages((prev) => {
          if (!isStreamingRef.current) {
            return parsed;
          }

          if (useBackendStreamingRenderRef.current) {
            return parsed;
          }

          const lastAssistantIdx = findLastAssistantIndex(parsed);
          if (lastAssistantIdx < 0) {
            return parsed;
          }

          const lastAssistant = parsed[lastAssistantIdx];
          const lastAssistantBlocks = extractRawBlocks(lastAssistant.raw);
          const toolUseCount = lastAssistantBlocks.filter((b) => b?.type === 'tool_use').length;
          if (toolUseCount < seenToolUseCountRef.current) {
            seenToolUseCountRef.current = toolUseCount;
          }
          const hasNewToolUse = toolUseCount > seenToolUseCountRef.current;
          const hasToolUse = toolUseCount > 0;

          // 工具调用是一个“阶段”边界：后续文本/思考应该进入新的段落
          if (hasNewToolUse) {
            seenToolUseCountRef.current = toolUseCount;
            activeTextSegmentIndexRef.current = -1;
            activeThinkingSegmentIndexRef.current = -1;
          }

          // 流式期间：仅当“没有新增消息且最后一条是 assistant 且不含 tool_use”时跳过，避免覆盖流式 UI
          const isAssistantOnlyRefresh =
            parsed.length === prev.length &&
            parsed[parsed.length - 1]?.type === 'assistant' &&
            !hasToolUse;
          if (isAssistantOnlyRefresh) {
            return prev;
          }

          const patched = [...parsed];
          const targetIdx = getOrCreateStreamingAssistantIndex(patched);
          if (targetIdx >= 0 && patched[targetIdx]?.type === 'assistant') {
            patched[targetIdx] = patchAssistantForStreaming(patched[targetIdx]);
          }
          return patched;
        });
      } catch (error) {
        console.error('[Frontend] Failed to parse messages:', error);
        console.error('[Frontend] Raw JSON:', json?.substring(0, 500));
      }
    };

    window.updateStatus = (text) => {
      setStatus(text);
      // 检查是否需要抑制 toast（删除当前会话后自动创建新会话的场景）
      if (suppressNextStatusToastRef.current) {
        suppressNextStatusToastRef.current = false;
        return;
      }
      // Show toast notification for status changes
      addToast(text);
    };
    window.showLoading = (value) => {
      const isLoading = isTruthy(value);
      setLoading(isLoading);
      if (isLoading) {
        setLoadingStartTime(Date.now());
      } else {
        setLoadingStartTime(null);
      }
    };
    window.showThinkingStatus = (value) => setIsThinking(isTruthy(value));
    window.setHistoryData = (data) => setHistoryData(data);
    window.clearMessages = () => setMessages([]);
    window.addErrorMessage = (message) =>
      setMessages((prev) => [...prev, { type: 'error', content: message }]);

    // 添加单条历史消息（用于 Codex 会话加载）
    window.addHistoryMessage = (message: ClaudeMessage) => {
      setMessages((prev) => [...prev, message]);
    };

    // 添加用户消息（用于外部 Quick Fix 功能）
    // Add user message to chat (for external Quick Fix feature)
    // Backend now waits for frontend_ready signal before calling this
    window.addUserMessage = (content: string) => {
      const userMessage: ClaudeMessage = {
        type: 'user',
        content: content || '',
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);
      // Auto-scroll to bottom to show the user's message
      isUserAtBottomRef.current = true;
      requestAnimationFrame(() => {
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
        }
      });
    };

    // 🔧 流式传输回调函数
    // 流式开始时调用
    window.onStreamStart = () => {
      console.log('[Frontend] Stream started');
      streamingContentRef.current = '';
      isStreamingRef.current = true;
      // Claude 流式：由后端通过 updateMessages 增量写入 raw blocks 进行渲染
      useBackendStreamingRenderRef.current = currentProviderRef.current === 'claude';
      autoExpandedThinkingKeysRef.current.clear();
      setStreamingActive(true);
      isUserAtBottomRef.current = true;
      streamingTextSegmentsRef.current = [];
      activeTextSegmentIndexRef.current = -1;
      streamingThinkingSegmentsRef.current = [];
      activeThinkingSegmentIndexRef.current = -1;
      seenToolUseCountRef.current = 0;

      // Claude 流式由后端通过 updateMessages 驱动，不需要前端占位消息
      if (useBackendStreamingRenderRef.current) {
        return;
      }
      // 添加一个占位的 assistant 消息用于流式更新
      setMessages((prev) => {
        // 检查最后一条消息是否已经是正在流式的 assistant 消息
        const last = prev[prev.length - 1];
        if (last?.type === 'assistant' && last?.isStreaming) {
          // 🔧 记录流式消息索引
          streamingMessageIndexRef.current = prev.length - 1;
          return prev; // 已存在，不重复添加
        }
        // 🔧 记录新增的流式消息索引
        streamingMessageIndexRef.current = prev.length;
        return [...prev, {
          type: 'assistant',
          content: '',
          isStreaming: true,
          timestamp: new Date().toISOString()
        }];
      });
    };

    // 内容增量回调 - 🔧 使用索引定位流式消息，避免 isStreaming 被覆盖问题
    window.onContentDelta = (delta: string) => {
      if (!isStreamingRef.current) return;
      streamingContentRef.current += delta;
      // 收到内容输出，视为当前 thinking 段结束（后续 thinking_delta 将新开一段）
      activeThinkingSegmentIndexRef.current = -1;

      // 🔧 计算/创建当前文本段（工具调用后会从新段开始）
      if (activeTextSegmentIndexRef.current < 0) {
        activeTextSegmentIndexRef.current = streamingTextSegmentsRef.current.length;
        streamingTextSegmentsRef.current.push('');
      }
      streamingTextSegmentsRef.current[activeTextSegmentIndexRef.current] += delta;

      const now = Date.now();
      const timeSinceLastUpdate = now - lastContentUpdateRef.current;

      // 🔧 真正的节流：如果距上次更新超过阈值，立即更新
      if (timeSinceLastUpdate >= THROTTLE_INTERVAL) {
        lastContentUpdateRef.current = now;
        const currentContent = streamingContentRef.current;
        setMessages((prev) => {
          const newMessages = [...prev];
          // 🔧 使用索引定位，而不是检查 isStreaming 标志（避免被 updateMessages 覆盖）
          const idx = getOrCreateStreamingAssistantIndex(newMessages);
          if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
            newMessages[idx] = patchAssistantForStreaming({
              ...newMessages[idx],
              content: currentContent,
              isStreaming: true,
            });
          }
          return newMessages;
        });
      } else {
        // 🔧 如果还没到阈值，确保在阈值到期时更新（不会丢失最后一次更新）
        if (!contentUpdateTimeoutRef.current) {
          const remainingTime = THROTTLE_INTERVAL - timeSinceLastUpdate;
          contentUpdateTimeoutRef.current = setTimeout(() => {
            contentUpdateTimeoutRef.current = null;
            lastContentUpdateRef.current = Date.now();
            const currentContent = streamingContentRef.current;
            setMessages((prev) => {
              const newMessages = [...prev];
              const idx = getOrCreateStreamingAssistantIndex(newMessages);
              if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
                newMessages[idx] = patchAssistantForStreaming({
                  ...newMessages[idx],
                  content: currentContent,
                  isStreaming: true,
                });
              }
              return newMessages;
            });
          }, remainingTime);
        }
      }
    };

    // 思考增量回调 - 🔧 使用索引定位流式消息
    window.onThinkingDelta = (delta: string) => {
      if (!isStreamingRef.current) return;
      // 🔧 统一换行符，但不在这里做过度清理（累积后在 buildStreamingBlocks 中统一处理）
      const normalizedDelta = delta.replace(/\r\n/g, '\n');
      // 🔧 多段 thinking：按"阶段"聚合（工具调用前/后分别进入不同段）
      if (activeThinkingSegmentIndexRef.current < 0) {
        const phaseIndex = activeTextSegmentIndexRef.current >= 0
          ? activeTextSegmentIndexRef.current
          : streamingTextSegmentsRef.current.length; // 工具调用后但文本未开始时，应进入下一段
        while (streamingThinkingSegmentsRef.current.length <= phaseIndex) {
          streamingThinkingSegmentsRef.current.push('');
        }
        activeThinkingSegmentIndexRef.current = phaseIndex;
      }
      streamingThinkingSegmentsRef.current[activeThinkingSegmentIndexRef.current] += normalizedDelta;

      const now = Date.now();
      const timeSinceLastUpdate = now - lastThinkingUpdateRef.current;

      // 更新 UI 的函数
      const updateThinkingUI = () => {
        setMessages((prev) => {
          const newMessages = [...prev];
          const idx = getOrCreateStreamingAssistantIndex(newMessages);
          if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
            newMessages[idx] = patchAssistantForStreaming({
              ...newMessages[idx],
              isStreaming: true,
            });

            const rawBlocks = extractRawBlocks(newMessages[idx].raw);
            let lastThinkingIndex = -1;
            for (let i = rawBlocks.length - 1; i >= 0; i -= 1) {
              if (rawBlocks[i]?.type === 'thinking') {
                lastThinkingIndex = i;
                break;
              }
            }
            if (lastThinkingIndex >= 0) {
              const thinkingKey = `${idx}_${lastThinkingIndex}`;
              setExpandedThinking((prevExpanded) => ({ ...prevExpanded, [thinkingKey]: true }));
            }
          }
          return newMessages;
        });
        setIsThinking(true);
      };

      // 🔧 真正的节流：如果距上次更新超过阈值，立即更新
      if (timeSinceLastUpdate >= THROTTLE_INTERVAL) {
        lastThinkingUpdateRef.current = now;
        updateThinkingUI();
      } else {
        // 🔧 如果还没到阈值，确保在阈值到期时更新
        if (!thinkingUpdateTimeoutRef.current) {
          const remainingTime = THROTTLE_INTERVAL - timeSinceLastUpdate;
          thinkingUpdateTimeoutRef.current = setTimeout(() => {
            thinkingUpdateTimeoutRef.current = null;
            lastThinkingUpdateRef.current = Date.now();
            updateThinkingUI();
          }, remainingTime);
        }
      }
    };

    // 流式结束回调
    window.onStreamEnd = () => {
      console.log('[Frontend] Stream ended');
      const useBackendRender = useBackendStreamingRenderRef.current;
      isStreamingRef.current = false;
      useBackendStreamingRenderRef.current = false;
      setStreamingActive(false);
      activeThinkingSegmentIndexRef.current = -1;
      activeTextSegmentIndexRef.current = -1;
      seenToolUseCountRef.current = 0;

      // 清除节流定时器
      if (contentUpdateTimeoutRef.current) {
        clearTimeout(contentUpdateTimeoutRef.current);
        contentUpdateTimeoutRef.current = null;
      }
      if (thinkingUpdateTimeoutRef.current) {
        clearTimeout(thinkingUpdateTimeoutRef.current);
        thinkingUpdateTimeoutRef.current = null;
      }

      if (useBackendRender) {
        const keysToCollapse = Array.from(autoExpandedThinkingKeysRef.current);
        autoExpandedThinkingKeysRef.current.clear();
        if (keysToCollapse.length > 0) {
          setExpandedThinking((prevExpanded) => {
            let changed = false;
            const next = { ...prevExpanded };
            for (const key of keysToCollapse) {
              if (next[key]) {
                next[key] = false;
                changed = true;
              }
            }
            return changed ? next : prevExpanded;
          });
        }

        streamingContentRef.current = '';
        streamingTextSegmentsRef.current = [];
        streamingThinkingSegmentsRef.current = [];
        streamingMessageIndexRef.current = -1;
        setIsThinking(false);
        return;
      }

      // 确保最终内容被写入
      const finalContent = streamingContentRef.current;
      // 🔧 捕获当前索引值
      const targetIdx = streamingMessageIndexRef.current;

      setMessages((prev) => {
        const newMessages = [...prev];
        const idx = targetIdx >= 0 && targetIdx < prev.length ? targetIdx : findLastAssistantIndex(newMessages);
        if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
          const patched = patchAssistantForStreaming(newMessages[idx]);
          const rawBlocks = extractRawBlocks(patched.raw);
          for (let blockIndex = 0; blockIndex < rawBlocks.length; blockIndex += 1) {
            if (rawBlocks[blockIndex]?.type === 'thinking') {
              const thinkingKey = `${idx}_${blockIndex}`;
              setExpandedThinking((prevExpanded) => ({ ...prevExpanded, [thinkingKey]: false }));
            }
          }
          newMessages[idx] = { ...patched, content: finalContent, isStreaming: false };
        }
        return newMessages;
      });

      // 重置流式状态
      streamingContentRef.current = '';
      streamingTextSegmentsRef.current = [];
      streamingThinkingSegmentsRef.current = [];
      // 🔧 重置索引
      streamingMessageIndexRef.current = -1;
      setIsThinking(false);
    };

    // 设置当前会话 ID（用于 rewind 功能）
    window.setSessionId = (sessionId: string) => {
      console.log('[Frontend] Received session ID:', sessionId);
      setCurrentSessionId(sessionId);
    };

    // 检查是否有待处理的 sessionId（Java 端可能先于 React 组件挂载）
    if ((window as any).__pendingSessionId) {
      console.log('[Frontend] Found pending session ID, applying...');
      setCurrentSessionId((window as any).__pendingSessionId);
      delete (window as any).__pendingSessionId;
    }

    // 注册 toast 回调（后端调用）
    window.addToast = (message, type) => {
      addToast(message, type);
    };

    // 注册导出会话数据回调
    window.onExportSessionData = (json) => {
      try {
        // 解析后端返回的数据
        const exportData = JSON.parse(json);
        const conversationMessages = exportData.messages || [];
        const title = exportData.title || 'session';
        const sessionId = exportData.sessionId || 'unknown';

        // 转换为 ClaudeMessage 格式
        const messages: ClaudeMessage[] = conversationMessages.map((msg: any) => {
          // 提取文本内容
          let contentText = '';
          if (msg.message?.content) {
            if (typeof msg.message.content === 'string') {
              contentText = msg.message.content;
            } else if (Array.isArray(msg.message.content)) {
              // 从数组中提取文本
              contentText = msg.message.content
                .filter((block: any) => block && block.type === 'text')
                .map((block: any) => block.text || '')
                .join('\n');
            }
          }

          return {
            type: msg.type || 'assistant',
            content: contentText,
            timestamp: msg.timestamp,
            raw: msg // 保留原始数据
          };
        });

        // 导入转换函数
        import('./utils/exportMarkdown').then(({ convertMessagesToJSON, downloadJSON }) => {
          const json = convertMessagesToJSON(messages, title);
          const filename = `${title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}_${sessionId.slice(0, 8)}.json`;
          downloadJSON(json, filename);
          // 注意：不在这里显示成功 toast，等待后端保存完成后再显示
        }).catch(error => {
          console.error('[Frontend] Failed to export session:', error);
          addToast(t('history.exportFailed'), 'error');
        });
      } catch (error) {
        console.error('[Frontend] Failed to parse export data:', error);
        addToast(t('history.exportFailed'), 'error');
      }
    };

    // 注册斜杠命令回调（接收 SDK 返回的命令列表）
    resetSlashCommandsState(); // 重置状态，确保首次加载时能正确触发刷新
    resetFileReferenceState(); // 重置文件引用状态，防止 Promise 泄漏
    setupSlashCommandsCallback();

    // 🔧 SDK 状态回调（用于在未安装时禁止提问）
    // 使用装饰器模式，保存原有回调并扩展，避免与 DependencySection 的回调冲突
    const originalUpdateDependencyStatus = window.updateDependencyStatus;
    window.updateDependencyStatus = (jsonStr: string) => {
      try {
        const status = JSON.parse(jsonStr);
        console.log('[Frontend] SDK status updated (App):', status);
        setSdkStatus(status);
        setSdkStatusLoaded(true); // 标记状态已加载
      } catch (error) {
        console.error('[Frontend] Failed to parse SDK status:', error);
        setSdkStatusLoaded(true); // 即使解析失败也标记为已加载，避免永久等待
      }
      // 如果有原有回调（来自 DependencySection），也调用它
      if (originalUpdateDependencyStatus && originalUpdateDependencyStatus !== window.updateDependencyStatus) {
        originalUpdateDependencyStatus(jsonStr);
      }
    };
    // 保存 App 的回调引用，供 DependencySection 使用
    (window as any)._appUpdateDependencyStatus = window.updateDependencyStatus;

    // 处理 pending 的 SDK 状态（后端可能在 React 初始化前就返回了）
    if (window.__pendingDependencyStatus) {
      console.log('[Frontend] Found pending dependency status, applying...');
      const pending = window.__pendingDependencyStatus;
      delete window.__pendingDependencyStatus;
      window.updateDependencyStatus?.(pending);
    }

    // 初始化请求 SDK 状态
    if (window.sendToJava) {
      window.sendToJava('get_dependency_status:');
    }

    // ChatInputBox 相关回调
    window.onUsageUpdate = (json) => {
      try {
        const data = JSON.parse(json);
        if (typeof data.percentage === 'number') {
          const used = typeof data.usedTokens === 'number' ? data.usedTokens : (typeof data.totalTokens === 'number' ? data.totalTokens : undefined);
          const max = typeof data.maxTokens === 'number' ? data.maxTokens : (typeof data.limit === 'number' ? data.limit : undefined);
          setUsagePercentage(data.percentage);
          setUsageUsedTokens(used);
          setUsageMaxTokens(max);
        }
      } catch (error) {
        console.error('[Frontend] Failed to parse usage update:', error);
      }
    };

    const updateMode = (mode?: PermissionMode, providerOverride?: string) => {
      const activeProvider = providerOverride || currentProviderRef.current;
      if (activeProvider === 'codex') {
        setPermissionMode('bypassPermissions');
        return;
      }
      if (mode === 'default' || mode === 'plan' || mode === 'acceptEdits' || mode === 'bypassPermissions') {
        setPermissionMode(mode);
        setClaudePermissionMode(mode);
      }
    };

    window.onModeChanged = (mode) => updateMode(mode as PermissionMode);

    // 后端主动推送权限模式（窗口初始化时调用）
    window.onModeReceived = (mode) => updateMode(mode as PermissionMode);

    // 后端主动通知模型变化时调用（使用 ref 避免闭包问题）
      window.onModelChanged = (modelId) => {
      // 使用 ref 获取最新的 provider 值，避免闭包捕获旧值
      const provider = currentProviderRef.current;
      console.log('[Frontend] onModelChanged:', { modelId, provider });
      if (provider === 'claude') {
        setSelectedClaudeModel(modelId);
      } else if (provider === 'codex') {
        setSelectedCodexModel(modelId);
      }
    };

    // 后端确认模型设置成功后调用（关键：确保前后端状态同步）
      window.onModelConfirmed = (modelId, provider) => {
      console.log('[Frontend] onModelConfirmed:', { modelId, provider });
      // 根据后端返回的 provider 更新对应的模型状态
      if (provider === 'claude') {
        setSelectedClaudeModel(modelId);
      } else if (provider === 'codex') {
        setSelectedCodexModel(modelId);
      }
    };

    window.updateActiveProvider = (jsonStr: string) => {
      try {
        const provider: ProviderConfig = JSON.parse(jsonStr);
        syncActiveProviderModelMapping(provider);
        setProviderConfigVersion(prev => prev + 1);
        setActiveProviderConfig(provider);
      } catch (error) {
        console.error('[Frontend] Failed to parse active provider in App:', error);
      }
    };

    window.updateThinkingEnabled = (jsonStr: string) => {
      const trimmed = (jsonStr || '').trim();
      try {
        const data = JSON.parse(trimmed);
        if (typeof data === 'boolean') {
          setClaudeSettingsAlwaysThinkingEnabled(data);
          return;
        }
        if (data && typeof data.enabled === 'boolean') {
          setClaudeSettingsAlwaysThinkingEnabled(data.enabled);
          return;
        }
      } catch {
        if (trimmed === 'true' || trimmed === 'false') {
          setClaudeSettingsAlwaysThinkingEnabled(trimmed === 'true');
        }
      }
    };

    // 🔧 流式传输开关状态同步回调
    window.updateStreamingEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setStreamingEnabledSetting(data.streamingEnabled ?? false);
      } catch (error) {
        console.error('[Frontend] Failed to parse streaming config:', error);
      }
    };

    // Retry getting active provider
    let retryCount = 0;
    const MAX_RETRIES = 30;
    const requestActiveProvider = () => {
      if (window.sendToJava) {
        sendBridgeMessage('get_active_provider');
      } else {
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          setTimeout(requestActiveProvider, 100);
        } else {
          console.warn('[Frontend] Failed to get active provider: bridge not available');
        }
      }
    };
    setTimeout(requestActiveProvider, 200);

    let thinkingRetryCount = 0;
    const MAX_THINKING_RETRIES = 30;
    const requestThinkingEnabled = () => {
      if (window.sendToJava) {
        sendBridgeMessage('get_thinking_enabled');
      } else {
        thinkingRetryCount++;
        if (thinkingRetryCount < MAX_THINKING_RETRIES) {
          setTimeout(requestThinkingEnabled, 100);
        }
      }
    };
    setTimeout(requestThinkingEnabled, 200);

    // 🔧 请求流式传输初始状态
    let streamingRetryCount = 0;
    const MAX_STREAMING_RETRIES = 30;
    const requestStreamingEnabled = () => {
      if (window.sendToJava) {
        sendBridgeMessage('get_streaming_enabled');
      } else {
        streamingRetryCount++;
        if (streamingRetryCount < MAX_STREAMING_RETRIES) {
          setTimeout(requestStreamingEnabled, 100);
        }
      }
    };
    setTimeout(requestStreamingEnabled, 200);

    // 权限弹窗回调
    window.showPermissionDialog = (json) => {
      console.log('[PERM_DEBUG][FRONTEND] showPermissionDialog called');
      console.log('[PERM_DEBUG][FRONTEND] Raw JSON:', json);
      try {
        const request = JSON.parse(json) as PermissionRequest;
        console.log('[PERM_DEBUG][FRONTEND] Parsed request:', request);
        console.log('[PERM_DEBUG][FRONTEND] channelId:', request.channelId);
        console.log('[PERM_DEBUG][FRONTEND] toolName:', request.toolName);
        if (permissionDialogOpenRef.current || currentPermissionRequestRef.current) {
          pendingPermissionRequestsRef.current.push(request);
          console.log('[PERM_DEBUG][FRONTEND] Dialog busy, queued request. queueSize=', pendingPermissionRequestsRef.current.length);
        } else {
          openPermissionDialog(request);
          console.log('[PERM_DEBUG][FRONTEND] Dialog state set to open');
        }
      } catch (error) {
        console.error('[PERM_DEBUG][FRONTEND] ERROR: Failed to parse permission request:', error);
      }
    };

    // AskUserQuestion 弹窗回调
    window.showAskUserQuestionDialog = (json) => {
      console.log('[ASK_USER_QUESTION][FRONTEND] showAskUserQuestionDialog called');
      console.log('[ASK_USER_QUESTION][FRONTEND] Raw JSON:', json);
      try {
        const request = JSON.parse(json) as AskUserQuestionRequest;
        console.log('[ASK_USER_QUESTION][FRONTEND] Parsed request:', request);
        console.log('[ASK_USER_QUESTION][FRONTEND] requestId:', request.requestId);
        console.log('[ASK_USER_QUESTION][FRONTEND] questions count:', request.questions?.length);
        if (askUserQuestionDialogOpenRef.current || currentAskUserQuestionRequestRef.current) {
          pendingAskUserQuestionRequestsRef.current.push(request);
          console.log('[ASK_USER_QUESTION][FRONTEND] Dialog busy, queued request. queueSize=', pendingAskUserQuestionRequestsRef.current.length);
        } else {
          openAskUserQuestionDialog(request);
          console.log('[ASK_USER_QUESTION][FRONTEND] Dialog state set to open');
        }
      } catch (error) {
        console.error('[ASK_USER_QUESTION][FRONTEND] ERROR: Failed to parse request:', error);
      }
    };

    // 【自动监听】更新 ContextBar（上面灰色条）- 由自动监听器调用
    window.addSelectionInfo = (selectionInfo) => {
      console.log('[Frontend] addSelectionInfo (auto) called:', selectionInfo);
      if (selectionInfo) {
        // Try to parse the format @path#Lstart-end or just @path
        // Regex: starts with @, captures path until # or end. Optional #L(start)[-(end)]
        const match = selectionInfo.match(/^@([^#]+)(?:#L(\d+)(?:-(\d+))?)?$/);
        if (match) {
          const file = match[1];
          const startLine = match[2] ? parseInt(match[2], 10) : undefined;
          const endLine = match[3] ? parseInt(match[3], 10) : (startLine !== undefined ? startLine : undefined);

          // 只更新 ContextBar 显示（不添加代码片段标签）
          setContextInfo({
            file,
            startLine,
            endLine,
            raw: selectionInfo
          });
          console.log('[Frontend] Updated ContextBar (auto):', { file, startLine, endLine });
        }
      }
    };

    // 【手动发送】添加代码片段标签到输入框 - 由右键"发送到 GUI"调用
    window.addCodeSnippet = (selectionInfo) => {
      console.log('[Frontend] addCodeSnippet (manual) called:', selectionInfo);
      if (selectionInfo && window.insertCodeSnippetAtCursor) {
        // 调用 ChatInputBox 注册的方法，在光标位置插入代码片段
        window.insertCodeSnippetAtCursor(selectionInfo);
      }
    };

    // 清除选中代码信息回调
    window.clearSelectionInfo = () => {
      console.log('[Frontend] clearSelectionInfo called');
      setContextInfo(null);
    };

    // 接收选中的智能体回调
    window.onSelectedAgentReceived = (json) => {
      console.log('[Frontend] onSelectedAgentReceived:', json);
      try {
        if (!json || json === 'null' || json === '{}') {
          setSelectedAgent(null);
          return;
        }
        const data = JSON.parse(json);
        const agentFromNewShape = data?.agent;
        const agentFromLegacyShape = data;

        const agentData = agentFromNewShape?.id ? agentFromNewShape : (agentFromLegacyShape?.id ? agentFromLegacyShape : null);
        if (!agentData) {
          setSelectedAgent(null);
          return;
        }

        setSelectedAgent({
          id: agentData.id,
          name: agentData.name || '',
          prompt: agentData.prompt,
        });
      } catch (error) {
        console.error('[Frontend] Failed to parse selected agent:', error);
        setSelectedAgent(null);
      }
    };

    // 智能体选择变更确认回调
    window.onSelectedAgentChanged = (json) => {
      console.log('[Frontend] onSelectedAgentChanged:', json);
      try {
        if (!json || json === 'null' || json === '{}') {
          setSelectedAgent(null);
          return;
        }

        const data = JSON.parse(json);
        if (data?.success === false) {
          return;
        }

        const agentData = data?.agent;
        if (!agentData || !agentData.id) {
          setSelectedAgent(null);
          return;
        }

        setSelectedAgent({
          id: agentData.id,
          name: agentData.name || '',
          prompt: agentData.prompt,
        });
      } catch (error) {
        console.error('[Frontend] Failed to parse selected agent changed:', error);
      }
    };

    // Rewind result callback from Java
    window.onRewindResult = (json: string) => {
      console.log('[Frontend] onRewindResult:', json);
      try {
        const result = JSON.parse(json);
        console.log('[Frontend] Parsed rewind result:', result);

        setIsRewinding(false);
        setRewindDialogOpen(false);
        setCurrentRewindRequest(null);

        if (result.success) {
          window.addToast?.(
            t('rewind.successSimple'),
            'success'
          );
        } else {
          window.addToast?.(
            result.message || t('rewind.failed'),
            'error'
          );
        }
      } catch (error) {
        console.error('[Frontend] Failed to parse rewind result:', error);
        setIsRewinding(false);
        setRewindDialogOpen(false);
        setCurrentRewindRequest(null);
        window.addToast?.(t('rewind.parseError'), 'error');
      }
    };
  }, []); // 移除 currentProvider 依赖，因为现在使用 ref 获取最新值

  useEffect(() => {
    if (currentView !== 'history') {
      return;
    }

    let historyRetryCount = 0;
    const MAX_HISTORY_RETRIES = 30; // 最多重试30次（3秒）
    let currentTimer: number | null = null;

    const requestHistoryData = () => {
      if (window.sendToJava) {
        // 传递 provider 参数给后端
        sendBridgeMessage('load_history_data', currentProvider);
      } else {
        historyRetryCount++;
        if (historyRetryCount < MAX_HISTORY_RETRIES) {
          currentTimer = setTimeout(requestHistoryData, 100);
        } else {
          console.warn('[Frontend] Failed to load history data: bridge not available after', MAX_HISTORY_RETRIES, 'retries');
        }
      }
    };

    currentTimer = setTimeout(requestHistoryData, 50);

    return () => {
      if (currentTimer) {
        clearTimeout(currentTimer);
      }
    };
  }, [currentView, currentProvider]); // 添加 currentProvider 依赖，provider 切换时自动刷新历史记录

  // 定期获取使用统计
  useEffect(() => {
    const requestUsageStats = () => {
      if (window.sendToJava) {
        console.log('[Frontend] Requesting get_usage_statistics (scope=current)');
        sendBridgeMessage('get_usage_statistics', JSON.stringify({ scope: 'current' }));
      }
    };

    // 初始请求
    const initTimer = setTimeout(requestUsageStats, 500);

    // 每 60 秒更新一次
    const intervalId = setInterval(requestUsageStats, 60000);

    return () => {
      clearTimeout(initTimer);
      clearInterval(intervalId);
      window.updateActiveProvider = undefined;
    };
  }, []);

  // 监听滚动事件，检测用户是否在底部
  // 原理：如果用户向上滚动查看历史，就标记为"不在底部"，不再自动滚动
  // 依赖 currentView 是因为视图切换时容器会重新挂载，需要重新绑定监听器
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // 🔧 如果正在自动滚动，跳过判断（防止快速流式输出时误判）
      if (isAutoScrollingRef.current) return;
      // 计算距离底部的距离
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      // 如果距离底部小于 100 像素，认为用户在底部
      isUserAtBottomRef.current = distanceFromBottom < 100;
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [currentView]);

  const scrollToBottom = useCallback(() => {
    const endElement = messagesEndRef.current;
    if (endElement) {
      isAutoScrollingRef.current = true;
      try {
        endElement.scrollIntoView({ block: 'end', behavior: 'auto' });
      } catch {
        endElement.scrollIntoView(false);
      }
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false;
      });
      return;
    }

    const container = messagesContainerRef.current;
    if (!container) return;

    isAutoScrollingRef.current = true;
    container.scrollTop = container.scrollHeight;
    requestAnimationFrame(() => {
      isAutoScrollingRef.current = false;
    });
  }, []);

  // 🔧 自动滚动：用户在底部时，跟随最新内容（包括流式/展开思考块/加载指示器等导致的高度变化）
  useLayoutEffect(() => {
    if (currentView !== 'chat') return;
    if (!isUserAtBottomRef.current) return;
    scrollToBottom();
  }, [currentView, messages, expandedThinking, loading, streamingActive, scrollToBottom]);

  // 切换回聊天视图时，自动滚动到底部
  useEffect(() => {
    if (currentView === 'chat') {
      // 使用 setTimeout 确保视图完全渲染后再滚动
      const timer = setTimeout(() => {
        scrollToBottom();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [currentView, scrollToBottom]);

  // 双击 ESC 快捷键打开回滚弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      // 如果有其他弹窗打开，不处理双击 ESC
      if (permissionDialogOpen || askUserQuestionDialogOpen || rewindDialogOpen || rewindSelectDialogOpen) {
        return;
      }

      // 只在 claude provider 且有消息时才触发
      if (currentProvider !== 'claude' || messages.length === 0) {
        return;
      }

      const now = Date.now();
      const timeSinceLastEsc = now - lastEscPressTimeRef.current;

      // 如果两次 ESC 间隔小于 400ms，触发回滚弹窗
      if (timeSinceLastEsc < 400) {
        e.preventDefault();
        setRewindSelectDialogOpen(true);
        lastEscPressTimeRef.current = 0; // 重置，避免连续触发
      } else {
        lastEscPressTimeRef.current = now;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentProvider, messages.length, permissionDialogOpen, askUserQuestionDialogOpen, rewindDialogOpen, rewindSelectDialogOpen]);

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
          // 非图片附件显示文件名
          userContentBlocks.push({
            type: 'text',
            text: `[附件: ${att.fileName}]`,
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

    // 立即在前端添加用户消息（包含图片预览）
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: text || (hasAttachments ? '[已上传附件]' : ''),
      timestamp: new Date().toISOString(),
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
    console.log('[DEBUG] Current provider before send:', currentProvider);
    sendBridgeMessage('set_provider', currentProvider);

    // 【FIX】构建智能体信息，随消息一起发送，确保每个标签页使用自己选择的智能体
    const agentInfo = selectedAgent ? {
      id: selectedAgent.id,
      name: selectedAgent.name,
      prompt: selectedAgent.prompt,
    } : null;

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
        });
        sendBridgeMessage('send_message_with_attachments', payload);
      } catch (error) {
        console.error('[Frontend] Failed to serialize attachments payload', error);
        // Fallback: send message with agent info
        const fallbackPayload = JSON.stringify({ text, agent: agentInfo });
        sendBridgeMessage('send_message', fallbackPayload);
      }
    } else {
      // 【FIX】将消息和智能体信息打包成 JSON 发送
      const payload = JSON.stringify({ text, agent: agentInfo });
      sendBridgeMessage('send_message', payload);
    }
  };

  /**
   * 处理模式选择
   */
  const handleModeSelect = (mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      setPermissionMode('bypassPermissions');
      sendBridgeMessage('set_mode', 'bypassPermissions');
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeMessage('set_mode', mode);
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
    sendBridgeMessage('set_model', modelId);
  };

  /**
   * 处理提供商选择
   */
  const handleProviderSelect = (providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeMessage('set_provider', providerId);
    const modeToSet = providerId === 'codex' ? 'bypassPermissions' : claudePermissionMode;
    setPermissionMode(modeToSet);
    sendBridgeMessage('set_mode', modeToSet);

    // 切换 provider 时,同时发送对应的模型
    const newModel = providerId === 'codex' ? selectedCodexModel : selectedClaudeModel;
    sendBridgeMessage('set_model', newModel);
  };

  /**
   * 处理智能体选择
   */
  const handleAgentSelect = (agent: SelectedAgent | null) => {
    setSelectedAgent(agent);
    if (agent) {
      sendBridgeMessage('set_selected_agent', JSON.stringify({
        id: agent.id,
        name: agent.name,
        prompt: agent.prompt,
      }));
    } else {
      sendBridgeMessage('set_selected_agent', '');
    }
  };

  /**
   * 处理思考模式切换
   */
  const handleToggleThinking = (enabled: boolean) => {
    if (!activeProviderConfig) {
      setClaudeSettingsAlwaysThinkingEnabled(enabled);
      sendBridgeMessage('set_thinking_enabled', JSON.stringify({ enabled }));
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
    sendBridgeMessage('update_provider', payload);
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  };

  /**
   * 处理流式传输开关切换
   */
  const handleStreamingEnabledChange = useCallback((enabled: boolean) => {
    setStreamingEnabledSetting(enabled);
    const payload = { streamingEnabled: enabled };
    sendBridgeMessage('set_streaming_enabled', JSON.stringify(payload));
    addToast(enabled ? t('settings.basic.streaming.enabled') : t('settings.basic.streaming.disabled'), 'success');
  }, [t, addToast]);

  const interruptSession = () => {
    sendBridgeMessage('interrupt_session');
    // 移除通知：已发送中断请求
  };

  // const restartSession = () => {
  //   if (window.confirm('确定要重启会话吗？这将清空当前对话历史。')) {
  //     sendBridgeMessage('restart_session');
  //     setMessages([]);
  //     addToast('正在重启会话...', 'info');
  //   }
  // };

  const createNewSession = () => {
    // 如果正在对话中，提示用户新建会话会中断对话
    if (loading) {
      setShowInterruptConfirm(true);
      return;
    }

    if (messages.length === 0) {
      // 移除通知：当前会话为空，可以直接使用
      return;
    }
    setShowNewSessionConfirm(true);
  };

  const handleConfirmNewSession = () => {
    setShowNewSessionConfirm(false);
    sendBridgeMessage('create_new_session');
    setMessages([]);
    setCurrentSessionId(null);
    // 重置使用量显示为 0%
    setUsagePercentage(0);
    setUsageUsedTokens(0);
    // 保留 maxTokens，等待后端推送；如果此前已知模型，可按默认 272K 预估
    setUsageMaxTokens((prev) => prev ?? 272000);
    // Toast is shown by backend when session is actually created
  };

  const handleCancelNewSession = () => {
    setShowNewSessionConfirm(false);
  };

  const handleConfirmInterrupt = () => {
    setShowInterruptConfirm(false);
    // 中断当前对话
    interruptSession();
    // 直接创建新会话，不再弹出第二个确认框
    sendBridgeMessage('create_new_session');
    setMessages([]);
    setCurrentSessionId(null);
    setUsagePercentage(0);
    setUsageUsedTokens(0);
    setUsageMaxTokens((prev) => prev ?? 272000);
    // Toast is shown by backend when session is actually created
  };

  const handleCancelInterrupt = () => {
    setShowInterruptConfirm(false);
  };

  /**
   * 处理权限批准（允许一次）
   */
  const handlePermissionApprove = (channelId: string) => {
    console.log('[PERM_DEBUG][FRONTEND] handlePermissionApprove called');
    console.log('[PERM_DEBUG][FRONTEND] channelId:', channelId);
    const payload = JSON.stringify({
      channelId,
      allow: true,
      remember: false,
      rejectMessage: null,
    });
    console.log('[PERM_DEBUG][FRONTEND] Sending decision payload:', payload);
    sendBridgeMessage('permission_decision', payload);
    console.log('[PERM_DEBUG][FRONTEND] Decision sent, closing dialog');
    permissionDialogOpenRef.current = false;
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  };

  /**
   * 处理权限批准（总是允许）
   */
  const handlePermissionApproveAlways = (channelId: string) => {
    console.log('[PERM_DEBUG][FRONTEND] handlePermissionApproveAlways called');
    console.log('[PERM_DEBUG][FRONTEND] channelId:', channelId);
    const payload = JSON.stringify({
      channelId,
      allow: true,
      remember: true,
      rejectMessage: null,
    });
    console.log('[PERM_DEBUG][FRONTEND] Sending decision payload:', payload);
    sendBridgeMessage('permission_decision', payload);
    console.log('[PERM_DEBUG][FRONTEND] Decision sent, closing dialog');
    permissionDialogOpenRef.current = false;
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  };

  /**
   * 处理 AskUserQuestion 提交
   */
  const handleAskUserQuestionSubmit = (requestId: string, answers: Record<string, string>) => {
    console.log('[ASK_USER_QUESTION][FRONTEND] handleAskUserQuestionSubmit called');
    console.log('[ASK_USER_QUESTION][FRONTEND] requestId:', requestId);
    console.log('[ASK_USER_QUESTION][FRONTEND] answers:', answers);
    const payload = JSON.stringify({
      requestId,
      answers,
    });
    console.log('[ASK_USER_QUESTION][FRONTEND] Sending response payload:', payload);
    sendBridgeMessage('ask_user_question_response', payload);
    console.log('[ASK_USER_QUESTION][FRONTEND] Response sent, closing dialog');
    askUserQuestionDialogOpenRef.current = false;
    currentAskUserQuestionRequestRef.current = null;
    setAskUserQuestionDialogOpen(false);
    setCurrentAskUserQuestionRequest(null);
  };

  /**
   * 处理 AskUserQuestion 取消
   */
  const handleAskUserQuestionCancel = (requestId: string) => {
    console.log('[ASK_USER_QUESTION][FRONTEND] handleAskUserQuestionCancel called');
    console.log('[ASK_USER_QUESTION][FRONTEND] requestId:', requestId);
    // 发送空答案表示用户取消
    const payload = JSON.stringify({
      requestId,
      answers: {},
    });
    console.log('[ASK_USER_QUESTION][FRONTEND] Sending cancel payload:', payload);
    sendBridgeMessage('ask_user_question_response', payload);
    console.log('[ASK_USER_QUESTION][FRONTEND] Cancel sent, closing dialog');
    askUserQuestionDialogOpenRef.current = false;
    currentAskUserQuestionRequestRef.current = null;
    setAskUserQuestionDialogOpen(false);
    setCurrentAskUserQuestionRequest(null);
  };

  /**
   * 处理权限拒绝
   */
  const handlePermissionSkip = (channelId: string) => {
    console.log('[PERM_DEBUG][FRONTEND] handlePermissionSkip called');
    console.log('[PERM_DEBUG][FRONTEND] channelId:', channelId);
    const payload = JSON.stringify({
      channelId,
      allow: false,
      remember: false,
      rejectMessage: t('permission.userDenied'),
    });
    console.log('[PERM_DEBUG][FRONTEND] Sending decision payload:', payload);
    sendBridgeMessage('permission_decision', payload);
    console.log('[PERM_DEBUG][FRONTEND] Decision sent, closing dialog');
    permissionDialogOpenRef.current = false;
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  };

  const toggleThinking = (messageIndex: number, blockIndex: number) => {
    const key = `${messageIndex}_${blockIndex}`;
    setExpandedThinking((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const isThinkingExpanded = (messageIndex: number, blockIndex: number) =>
    Boolean(expandedThinking[`${messageIndex}_${blockIndex}`]);

  const loadHistorySession = (sessionId: string) => {
    sendBridgeMessage('load_session', sessionId);
    setCurrentSessionId(sessionId);
    setCurrentView('chat');
  };

  // 删除会话历史
  const deleteHistorySession = (sessionId: string) => {
    // 发送删除请求到 Java 后端
    sendBridgeMessage('delete_session', sessionId);

    // 立即更新前端状态,从历史列表中移除该会话
    if (historyData && historyData.sessions) {
      const updatedSessions = historyData.sessions.filter(s => s.sessionId !== sessionId);
      const deletedSession = historyData.sessions.find(s => s.sessionId === sessionId);
      const updatedTotal = (historyData.total || 0) - (deletedSession?.messageCount || 0);

      setHistoryData({
        ...historyData,
        sessions: updatedSessions,
        total: updatedTotal
      });

      // 如果删除的是当前会话，清空消息并重置状态
      if (sessionId === currentSessionId) {
        setMessages([]);
        setCurrentSessionId(null);
        setUsagePercentage(0);
        setUsageUsedTokens(0);
        // 设置标志位，抑制后端 createNewSession 触发的 updateStatus toast
        suppressNextStatusToastRef.current = true;
        sendBridgeMessage('create_new_session');
      }

      // 显示成功提示
      addToast(t('history.sessionDeleted'), 'success');
    }
  };

  // 导出会话历史
  const exportHistorySession = (sessionId: string, title: string) => {
    // 发送导出请求到 Java 后端，包含 sessionId 和 title
    const exportData = JSON.stringify({ sessionId, title });
    sendBridgeMessage('export_session', exportData);
  };

  // 切换收藏状态
  const toggleFavoriteSession = (sessionId: string) => {
    // 发送收藏切换请求到后端
    sendBridgeMessage('toggle_favorite', sessionId);

    // 立即更新前端状态
    if (historyData && historyData.sessions) {
      const updatedSessions = historyData.sessions.map(session => {
        if (session.sessionId === sessionId) {
          const isFavorited = !session.isFavorited;
          return {
            ...session,
            isFavorited,
            favoritedAt: isFavorited ? Date.now() : undefined
          };
        }
        return session;
      });

      setHistoryData({
        ...historyData,
        sessions: updatedSessions
      });

      // 显示提示
      const session = historyData.sessions.find(s => s.sessionId === sessionId);
      if (session?.isFavorited) {
        addToast(t('history.unfavorited'), 'success');
      } else {
        addToast(t('history.favorited'), 'success');
      }
    }
  };

  // 更新会话标题
  const updateHistoryTitle = (sessionId: string, newTitle: string) => {
    // 发送更新标题请求到后端
    const updateData = JSON.stringify({ sessionId, customTitle: newTitle });
    sendBridgeMessage('update_title', updateData);

    // 立即更新前端状态
    if (historyData && historyData.sessions) {
      const updatedSessions = historyData.sessions.map(session => {
        if (session.sessionId === sessionId) {
          return {
            ...session,
            title: newTitle
          };
        }
        return session;
      });

      setHistoryData({
        ...historyData,
        sessions: updatedSessions
      });

      // 显示成功提示
      addToast(t('history.titleUpdated'), 'success');
    }
  };

  // 文案本地化映射
  const localizeMessage = (text: string): string => {
    const messageMap: Record<string, string> = {
      'Request interrupted by user': '请求已被用户中断',
    };

    // 检查是否有完全匹配的映射
    if (messageMap[text]) {
      return messageMap[text];
    }

    // 检查是否包含需要映射的关键词
    for (const [key, value] of Object.entries(messageMap)) {
      if (text.includes(key)) {
        return text.replace(key, value);
      }
    }

    return text;
  };

  const getMessageText = (message: ClaudeMessage) => {
    let text = '';

    if (message.content) {
      text = message.content;
    } else {
      const raw = message.raw;
      if (!raw) {
        return `(${t('chat.emptyMessage')})`;
      }
      if (typeof raw === 'string') {
        text = raw;
      } else if (typeof raw.content === 'string') {
        text = raw.content;
      } else if (Array.isArray(raw.content)) {
        text = raw.content
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
      } else if (raw.message?.content && Array.isArray(raw.message.content)) {
        text = raw.message.content
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
      } else {
        return `(${t('chat.emptyMessage')})`;
      }
    }

    // 应用本地化
    return localizeMessage(text);
  };

  const shouldShowMessage = (message: ClaudeMessage) => {
    // 过滤 isMeta 消息（如 "Caveat: The messages below were generated..."）
    if (message.raw && typeof message.raw === 'object' && 'isMeta' in message.raw && message.raw.isMeta === true) {
      return false;
    }

    // 过滤命令消息（包含 <command-name> 或 <local-command-stdout> 标签）
    const text = getMessageText(message);
    if (text && (
      text.includes('<command-name>') ||
      text.includes('<local-command-stdout>') ||
      text.includes('<local-command-stderr>') ||
      text.includes('<command-message>') ||
      text.includes('<command-args>')
    )) {
      return false;
    }
    if (message.type === 'user' && text === '[tool_result]') {
      return false;
    }
    if (message.type === 'assistant') {
      return true;
    }
    if (message.type === 'user' || message.type === 'error') {
      // 检查是否有有效的文本内容
      if (text && text.trim() && text !== `(${t('chat.emptyMessage')})` && text !== `(${t('chat.parseError')})`) {
        return true;
      }
      // 检查是否有有效的内容块（如图片等）
      const rawBlocks = normalizeBlocks(message.raw);
      if (Array.isArray(rawBlocks) && rawBlocks.length > 0) {
        // 确保至少有一个非空的内容块
        const hasValidBlock = rawBlocks.some(block => {
          if (block.type === 'text') {
            return block.text && block.text.trim().length > 0;
          }
          // 图片、工具使用等其他类型的块都应该显示
          return true;
        });
        return hasValidBlock;
      }
      return false;
    }
    return true;
  };

  const normalizeBlocks = (raw?: ClaudeRawMessage | string) => {
    if (!raw) {
      return null;
    }
    if (typeof raw === 'string') {
      return [{ type: 'text' as const, text: raw }];
    }
    const buildBlocksFromArray = (entries: unknown[]): ClaudeContentBlock[] => {
      const blocks: ClaudeContentBlock[] = [];
      entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const candidate = entry as Record<string, unknown>;
        const type = candidate.type as string | undefined;
        if (type === 'text') {
          const rawText = typeof candidate.text === 'string' ? candidate.text : '';
          // 某些回复包含占位文本 "(no content)", 直接忽略避免渲染空内容
          if (rawText.trim() === '(no content)') {
            return;
          }
          blocks.push({
            type: 'text',
            text: localizeMessage(rawText),
          });
        } else if (type === 'thinking') {
          const thinking =
            typeof candidate.thinking === 'string'
              ? (candidate.thinking as string)
              : typeof candidate.text === 'string'
                ? (candidate.text as string)
                : '';
          blocks.push({
            type: 'thinking',
            thinking,
            text: thinking,
          });
        } else if (type === 'tool_use') {
          blocks.push({
            type: 'tool_use',
            id: typeof candidate.id === 'string' ? (candidate.id as string) : undefined,
            name: typeof candidate.name === 'string' ? (candidate.name as string) : t('tools.unknownTool'),
            input: (candidate.input as Record<string, unknown>) ?? {},
          });
        } else if (type === 'image') {
          const source = (candidate as any).source;
          let src: string | undefined;
          let mediaType: string | undefined;

          // 支持两种格式：
          // 1. 后端/历史格式: { type: 'image', source: { type: 'base64', media_type: '...', data: '...' } }
          // 2. 前端直接格式: { type: 'image', src: 'data:...', mediaType: '...' }
          if (source && typeof source === 'object') {
            const st = source.type;
            if (st === 'base64' && typeof source.data === 'string') {
              const mt = typeof source.media_type === 'string' ? source.media_type : 'image/png';
              src = `data:${mt};base64,${source.data}`;
              mediaType = mt;
            } else if (st === 'url' && typeof source.url === 'string') {
              src = source.url;
              mediaType = source.media_type;
            }
          } else if (typeof candidate.src === 'string') {
            // 前端直接添加的格式
            src = candidate.src as string;
            mediaType = candidate.mediaType as string | undefined;
          }

          if (src) {
            blocks.push({ type: 'image', src, mediaType });
          }
        }
      });
      return blocks;
    };

    const pickContent = (content: unknown): ClaudeContentBlock[] | null => {
      if (!content) {
        return null;
      }
      if (typeof content === 'string') {
        // 过滤空字符串和命令消息
        if (!content.trim() ||
            content.includes('<command-name>') ||
            content.includes('<local-command-stdout>')) {
          return null;
        }
        return [{ type: 'text' as const, text: localizeMessage(content) }];
      }
      if (Array.isArray(content)) {
        const result = buildBlocksFromArray(content);
        return result.length ? result : null;
      }
      return null;
    };

    const contentBlocks = pickContent(raw.message?.content ?? raw.content);

    // 如果无法解析内容，尝试从其他字段获取
    if (!contentBlocks) {
      // 尝试从 raw.text 或其他可能的字段获取
      if (typeof raw === 'object') {
        if ('text' in raw && typeof raw.text === 'string' && raw.text.trim()) {
          return [{ type: 'text' as const, text: localizeMessage(raw.text) }];
        }
        // 如果实在没有内容，返回 null 而不是显示"(无法解析内容)"
        // 这样 shouldShowMessage 会过滤掉这条消息
      }
      return null;
    }

    return contentBlocks;
  };

  const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] => {
    const rawBlocks = normalizeBlocks(message.raw);
    if (rawBlocks && rawBlocks.length > 0) {
      // 🔧 流式/工具场景：如果 raw 里没有 text，但 message.content 有文本，仍需要展示文本
      const hasTextBlock = rawBlocks.some(
        (block) => block.type === 'text' && typeof (block as any).text === 'string' && String((block as any).text).trim().length > 0,
      );
      if (!hasTextBlock && message.content && message.content.trim()) {
        return [...rawBlocks, { type: 'text', text: localizeMessage(message.content) }];
      }
      return rawBlocks;
    }
    if (message.content && message.content.trim()) {
      return [{ type: 'text', text: localizeMessage(message.content) }];
    }
    // 如果没有任何内容，返回空数组而不是显示"(空消息)"
    // shouldShowMessage 会过滤掉这些消息
    return [];
  };

  // 合并相邻的 Assistant 消息，解决历史记录中 Thinking 和 ToolUse 分离导致样式不一致的问题
  const mergedMessages = useMemo(() => {
    // 先过滤不需要显示的消息
    const visible = messages.filter(shouldShowMessage);
    if (visible.length === 0) return [];

    const result: ClaudeMessage[] = [];
    let current: ClaudeMessage | null = null;

    for (const msg of visible) {
      if (!current) {
        current = msg;
        continue;
      }

      if (current.type === 'assistant' && msg.type === 'assistant') {
        // 合并逻辑
        const blocks1 = normalizeBlocks(current.raw) || [];
        const blocks2 = normalizeBlocks(msg.raw) || [];
        const combinedBlocks = [...blocks1, ...blocks2];

        // 构建新的 raw 对象
        const newRaw: ClaudeRawMessage = {
          ...(typeof current.raw === 'object' ? current.raw : {}),
          content: combinedBlocks
        };
        
        // 如果原始消息有 message.content，也需要更新它以保持一致性
        if (newRaw.message && newRaw.message.content) {
            newRaw.message.content = combinedBlocks;
        }

        const content1: string = current.content || '';
        const content2: string = msg.content || '';
        const newContent: string = (content1 && content2) ? `${content1}\n${content2}` : (content1 || content2);

        current = {
          ...current,
          content: newContent,
          raw: newRaw,
        };
      } else {
        result.push(current);
        current = msg;
      }
    }
    if (current) result.push(current);
    return result;
  }, [messages]);

// Claude 流式：思考块在输出中自动展开，输出结束自动折叠（见 onStreamEnd）
  useEffect(() => {
    if (currentProvider !== 'claude') return;
    if (!streamingActive) return;

    let lastAssistantIdx = -1;
    for (let i = mergedMessages.length - 1; i >= 0; i -= 1) {
      if (mergedMessages[i]?.type === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx < 0) return;

    const blocks = getContentBlocks(mergedMessages[lastAssistantIdx]);
    if (!Array.isArray(blocks) || blocks.length === 0) return;

    const keysToOpen: string[] = [];
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      if (blocks[blockIndex]?.type === 'thinking') {
        keysToOpen.push(`${lastAssistantIdx}_${blockIndex}`);
      }
    }
    if (keysToOpen.length === 0) return;

    setExpandedThinking((prevExpanded) => {
      let changed = false;
      const next = { ...prevExpanded };
      for (const key of keysToOpen) {
        if (!next[key]) {
          next[key] = true;
          autoExpandedThinkingKeysRef.current.add(key);
          changed = true;
        }
      }
      return changed ? next : prevExpanded;
    });
  }, [currentProvider, mergedMessages, streamingActive]);

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
        const toolName = (block.name ?? '').toLowerCase();
        // Include all file modification tools: write (create), edit, notebookedit, etc.
        if (['write', 'edit', 'edit_file', 'replace_string', 'write_to_file', 'notebookedit', 'create_file'].includes(toolName)) {
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

  const findToolResult = useCallback((toolUseId?: string, messageIndex?: number): ToolResultBlock | null => {
    if (!toolUseId || typeof messageIndex !== 'number') {
      return null;
    }

    // 注意：在原始 messages 数组中查找，而不是 mergedMessages
    // 因为 tool_result 可能在被过滤掉的消息中
    for (let i = 0; i < messages.length; i += 1) {
      const candidate = messages[i];
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
  }, [messages]);

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
      <style>{`
        .version-tag {
          position: absolute;
          top: -2px;
          left: 100%;
          margin-left: 10px;
          background: rgba(139, 92, 246, 0.1);
          border: 1px solid rgba(139, 92, 246, 0.5);
          color: #ddd6fe;
          font-size: 10px;
          padding: 2px 8px;
          border-radius: 4px;
          font-weight: 500;
          white-space: nowrap;
          box-shadow: 0 0 10px rgba(139, 92, 246, 0.15);
          backdrop-filter: blur(4px);
          z-index: 10;
        }
        
        [data-theme="light"] .version-tag {
          background: rgba(139, 92, 246, 0.1);
          border: 1px solid rgba(139, 92, 246, 0.3);
          color: #6d28d9;
          box-shadow: none;
          backdrop-filter: none;
        }
      `}</style>
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      {currentView !== 'settings' && (
        <div className="header">
          <div className="header-left">
            {currentView === 'history' ? (
              <button className="back-button" onClick={() => setCurrentView('chat')} data-tooltip={t('common.back')}>
                <BackIcon /> {t('common.back')}
              </button>
            ) : (
              <div
                className="session-title"
                style={{
                  fontWeight: 600,
                  fontSize: '14px',
                  paddingLeft: '8px',
                }}
              >
                {sessionTitle}
              </div>
            )}
          </div>
          <div className="header-right">
            {currentView === 'chat' && (
              <>
                <button className="icon-button" onClick={createNewSession} data-tooltip={t('common.newSession')}>
                  <span className="codicon codicon-plus" />
                </button>
                <button
                  className="icon-button"
                  onClick={() => sendBridgeMessage('create_new_tab')}
                  data-tooltip={t('common.newTab')}
                >
                  <span className="codicon codicon-split-horizontal" style={{ fontSize: '14px' }} />
                </button>
                <button
                  className="icon-button"
                  onClick={() => setCurrentView('history')}
                  data-tooltip={t('common.history')}
                >
                  <span className="codicon codicon-history" />
                </button>
                <button
                  className="icon-button"
                  onClick={() => {
                    setSettingsInitialTab(undefined);
                    setCurrentView('settings');
                  }}
                  data-tooltip={t('common.settings')}
                >
                  <span className="codicon codicon-settings-gear" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {currentView === 'settings' ? (
        <SettingsView
          onClose={() => setCurrentView('chat')}
          initialTab={settingsInitialTab}
          currentProvider={currentProvider}
          streamingEnabled={streamingEnabledSetting}
          onStreamingEnabledChange={handleStreamingEnabledChange}
        />
      ) : currentView === 'chat' ? (
        <>
          <div className="messages-container" ref={messagesContainerRef}>
          {messages.length === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#555',
                gap: '16px',
              }}
            >
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <BlinkingLogo provider={currentProvider} onProviderChange={handleProviderSelect} />
                <span className="version-tag">
                  v{APP_VERSION}
                </span>
              </div>
              <div>
                <AnimatedText text={t('chat.sendMessage', { provider: currentProvider === 'codex' ? 'Codex Cli' : 'Claude Code' })} />
              </div>
            </div>
          )}

          {mergedMessages.map((message, messageIndex) => {
            // mergedMessages 已经过滤了不显示的消息

            return (
              <div key={messageIndex} className={`message ${message.type}`}>
                {message.type === 'user' && message.timestamp && (
                  <div className="message-header-row">
                    <div className="message-timestamp-header">
                      {formatTime(message.timestamp)}
                    </div>
                  </div>
                )}
                {message.type !== 'assistant' && message.type !== 'user' && (
                  <div className="message-role-label">
                    {message.type}
                  </div>
                )}
                <div className="message-content">
                  {message.type === 'error' ? (
                    <MarkdownBlock content={getMessageText(message)} />
                  ) : (
                    getContentBlocks(message).map((block, blockIndex) => (
                      <div key={`${messageIndex}-${blockIndex}`} className="content-block">
                         {block.type === 'text' && (
                           message.type === 'user' ? (
                             <CollapsibleTextBlock content={block.text ?? ''} />
                           ) : (
                            <MarkdownBlock
                              content={block.text ?? ''}
                              isStreaming={streamingActive && message.type === 'assistant' && messageIndex === mergedMessages.length - 1}
                            />
                           )
                         )}
                        {block.type === 'image' && block.src && (
                          <div
                            className={`message-image-block ${message.type === 'user' ? 'user-image' : ''}`}
                            onClick={() => {
                              // 打开图片预览
                              const previewRoot = document.getElementById('image-preview-root');
                              if (previewRoot && block.src) {
                                previewRoot.innerHTML = `
                                  <div class="image-preview-overlay" onclick="this.remove()">
                                    <img src="${block.src}" alt={t('chat.imagePreview')} class="image-preview-content" onclick="event.stopPropagation()" />
                                    <div class="image-preview-close" onclick="this.parentElement.remove()">×</div>
                                  </div>
                                `;
                              }
                            }}
                            style={{ cursor: 'pointer' }}
                            title={t('chat.clickToPreview')}
                          >
                            <img
                              src={block.src}
                              alt={t('chat.userUploadedImage')}
                              style={{
                                maxWidth: message.type === 'user' ? '200px' : '100%',
                                maxHeight: message.type === 'user' ? '150px' : 'auto',
                                borderRadius: '8px',
                                objectFit: 'contain',
                              }}
                            />
                          </div>
                        )}

                        {block.type === 'thinking' && (
                          <div className="thinking-block">
                            <div
                              className="thinking-header"
                              onClick={() => toggleThinking(messageIndex, blockIndex)}
                            >
                              <span className="thinking-title">
                                {isThinking && messageIndex === mergedMessages.length - 1
                                  ? t('common.thinking')
                                  : t('common.thinkingProcess')}
                              </span>
                              <span className="thinking-icon">
                                {isThinkingExpanded(messageIndex, blockIndex) ? '▼' : '▶'}
                              </span>
                            </div>
                            {isThinkingExpanded(messageIndex, blockIndex) && (
                              <div className="thinking-content">
                                <MarkdownBlock
                                  content={block.thinking ?? block.text ?? t('chat.noThinkingContent')}
                                  isStreaming={streamingActive && message.type === 'assistant' && messageIndex === mergedMessages.length - 1}
                                />
                              </div>
                            )}
                          </div>
                        )}

                        {block.type === 'tool_use' && (
                          <>
                            {block.name?.toLowerCase() === 'todowrite' &&
                            Array.isArray((block.input as { todos?: TodoItem[] })?.todos) ? (
                              <TodoListBlock
                                todos={(block.input as { todos?: TodoItem[] })?.todos ?? []}
                              />
                            ) : block.name?.toLowerCase() === 'task' ? (
                              <TaskExecutionBlock input={block.input} />
                            ) : block.name &&
                              ['read', 'read_file'].includes(block.name.toLowerCase()) ? (
                              <ReadToolBlock input={block.input} />
                            ) : block.name &&
                              ['edit', 'edit_file', 'replace_string', 'write_to_file'].includes(
                                block.name.toLowerCase(),
                              ) ? (
                              <EditToolBlock name={block.name} input={block.input} result={findToolResult(block.id, messageIndex)} />
                            ) : block.name &&
                              ['bash', 'run_terminal_cmd', 'execute_command', 'shell_command'].includes(
                                block.name.toLowerCase(),
                              ) ? (
                              <BashToolBlock
                                name={block.name}
                                input={block.input}
                                result={findToolResult(block.id, messageIndex)}
                              />
                            ) : (
                              <GenericToolBlock name={block.name} input={block.input} result={findToolResult(block.id, messageIndex)} />
                            )}
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}

          {/* Thinking indicator */}
          {/* {isThinking && !hasThinkingBlockInLastMessage && (
            <div className="message assistant">
              <div className="thinking-status">
                <span className="thinking-status-icon">🤔</span>
                <span className="thinking-status-text">{t('common.thinking')}</span>
              </div>
            </div>
          )} */}

          {/* Loading indicator */}
          {loading && <WaitingIndicator startTime={loadingStartTime ?? undefined} />}
          <div ref={messagesEndRef} />
        </div>

        {/* 滚动控制按钮 */}
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
        <div className="input-area" ref={inputAreaRef}>
          <ChatInputBox
            isLoading={loading}
            selectedModel={selectedModel}
            permissionMode={permissionMode}
            currentProvider={currentProvider}
            usagePercentage={usagePercentage}
            usageUsedTokens={usageUsedTokens}
            usageMaxTokens={usageMaxTokens}
            showUsage={true}
            alwaysThinkingEnabled={activeProviderConfig?.settingsConfig?.alwaysThinkingEnabled ?? claudeSettingsAlwaysThinkingEnabled}
            placeholder={t('chat.inputPlaceholder')}
            sdkInstalled={currentSdkInstalled}
            sdkStatusLoading={!sdkStatusLoaded}
            onInstallSdk={() => {
              setSettingsInitialTab('dependencies');
              setCurrentView('settings');
            }}
            value={draftInput}
            onInput={setDraftInput}
            onSubmit={handleSubmit}
            onStop={interruptSession}
            onModeSelect={handleModeSelect}
            onModelSelect={handleModelSelect}
            onProviderSelect={handleProviderSelect}
            onToggleThinking={handleToggleThinking}
            streamingEnabled={streamingEnabledSetting}
            onStreamingEnabledChange={handleStreamingEnabledChange}
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
