import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownBlock from './components/MarkdownBlock';
import HistoryView from './components/history/HistoryView';
import SettingsView from './components/settings';
import ConfirmDialog from './components/ConfirmDialog';
import PermissionDialog, { type PermissionRequest } from './components/PermissionDialog';
import { ChatInputBox } from './components/ChatInputBox';
import { CLAUDE_MODELS, CODEX_MODELS } from './components/ChatInputBox/types';
import type { Attachment, PermissionMode } from './components/ChatInputBox/types';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  ReadToolBlock,
  TaskExecutionBlock,
  TodoListBlock,
} from './components/toolBlocks';
import { BackIcon } from './components/Icons';
import { Claude, OpenAI } from '@lobehub/icons';
import { ToastContainer, type ToastMessage } from './components/Toast';
import WaitingIndicator from './components/WaitingIndicator';
import { ScrollControl } from './components/ScrollControl';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeRawMessage,
  HistoryData,
  TodoItem,
  ToolResultBlock,
} from './types';

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
  const [currentView, setCurrentView] = useState<ViewMode>('chat');
  const [historyData, setHistoryData] = useState<HistoryData | null>(null);
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [showInterruptConfirm, setShowInterruptConfirm] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // 权限弹窗状态
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PermissionRequest | null>(null);

  // ChatInputBox 相关状态
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [selectedClaudeModel, setSelectedClaudeModel] = useState(CLAUDE_MODELS[0].id);
  const [selectedCodexModel, setSelectedCodexModel] = useState(CODEX_MODELS[0].id);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [usagePercentage, setUsagePercentage] = useState(0);
  const [usageUsedTokens, setUsageUsedTokens] = useState<number | undefined>(undefined);
  const [usageMaxTokens, setUsageMaxTokens] = useState<number | undefined>(undefined);
  const [inputValue, setInputValue] = useState('');

  // 根据当前提供商选择显示的模型
  const selectedModel = currentProvider === 'codex' ? selectedCodexModel : selectedClaudeModel;

  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const inputAreaRef = useRef<HTMLDivElement | null>(null);

  // 初始化主题
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    const theme = (savedTheme === 'light' || savedTheme === 'dark') ? savedTheme : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }, []);

  // 从 LocalStorage 加载模型选择状态
  useEffect(() => {
    try {
      const saved = localStorage.getItem('model-selection-state');
      if (saved) {
        const state = JSON.parse(saved);

        // 验证并恢复提供商
        if (['claude', 'codex'].includes(state.provider)) {
          setCurrentProvider(state.provider);
        }

        // 验证并恢复 Claude 模型
        if (CLAUDE_MODELS.find(m => m.id === state.claudeModel)) {
          setSelectedClaudeModel(state.claudeModel);
        }

        // 验证并恢复 Codex 模型
        if (CODEX_MODELS.find(m => m.id === state.codexModel)) {
          setSelectedCodexModel(state.codexModel);
        }
      }
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

  useEffect(() => {
    window.updateMessages = (json) => {
      try {
        const parsed = JSON.parse(json) as ClaudeMessage[];
        setMessages(parsed);
      } catch (error) {
        console.error('[Frontend] Failed to parse messages:', error);
      }
    };

    window.updateStatus = (text) => {
      setStatus(text);
      // Show toast notification for status changes
      addToast(text);
    };
    window.showLoading = (value) => {
      const isLoading = isTruthy(value);
      setLoading(isLoading);
      // 开始加载时记录时间，结束时清除
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

    // ChatInputBox 相关回调
    window.onUsageUpdate = (json) => {
      try {
        console.log('[Frontend] onUsageUpdate raw:', json);
        const data = JSON.parse(json);
        if (typeof data.percentage === 'number') {
          console.log('[Frontend] onUsageUpdate parsed percentage:', data.percentage, 'totalTokens:', data.totalTokens, 'limit:', data.limit);
          setUsagePercentage(data.percentage);
          const used = typeof data.usedTokens === 'number' ? data.usedTokens : (typeof data.totalTokens === 'number' ? data.totalTokens : undefined);
          const max = typeof data.maxTokens === 'number' ? data.maxTokens : (typeof data.limit === 'number' ? data.limit : undefined);
          setUsageUsedTokens(used);
          setUsageMaxTokens(max);
        }
      } catch (error) {
        console.error('[Frontend] Failed to parse usage update:', error);
      }
    };

    window.onModeChanged = (mode) => {
      if (mode === 'default' || mode === 'plan' || mode === 'bypassPermissions') {
        setPermissionMode(mode);
      }
    };

    window.onModelChanged = (modelId) => {
      // 根据当前提供商更新对应的模型状态
      if (currentProvider === 'claude') {
        setSelectedClaudeModel(modelId);
      } else if (currentProvider === 'codex') {
        setSelectedCodexModel(modelId);
      }
    };

    // 权限弹窗回调
    window.showPermissionDialog = (json) => {
      console.log('[PERM_DEBUG][FRONTEND] showPermissionDialog called');
      console.log('[PERM_DEBUG][FRONTEND] Raw JSON:', json);
      try {
        const request = JSON.parse(json) as PermissionRequest;
        console.log('[PERM_DEBUG][FRONTEND] Parsed request:', request);
        console.log('[PERM_DEBUG][FRONTEND] channelId:', request.channelId);
        console.log('[PERM_DEBUG][FRONTEND] toolName:', request.toolName);
        setCurrentPermissionRequest(request);
        setPermissionDialogOpen(true);
        console.log('[PERM_DEBUG][FRONTEND] Dialog state set to open');
      } catch (error) {
        console.error('[PERM_DEBUG][FRONTEND] ERROR: Failed to parse permission request:', error);
      }
    };

    // 选中代码发送到终端回调
    window.addSelectionInfo = (selectionInfo) => {
      console.log('[Frontend] addSelectionInfo called:', selectionInfo);
      if (selectionInfo) {
        // 将选中的代码引用添加到输入框
        setInputValue((prev) => {
          const separator = prev.trim() ? ' ' : '';
          return prev + separator + selectionInfo;
        });
      }
    };
  }, [currentProvider]);

  useEffect(() => {
    if (currentView !== 'history') {
      return;
    }

    const requestHistoryData = () => {
      if (window.sendToJava) {
        sendBridgeMessage('load_history_data');
      } else {
        setTimeout(requestHistoryData, 100);
      }
    };

    const timer = setTimeout(requestHistoryData, 50);
    return () => clearTimeout(timer);
  }, [currentView]);

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
    };
  }, []);

  useEffect(() => {
    if (messagesContainerRef.current) {
      // 使用 requestAnimationFrame 确保 DOM 已完全渲染
      requestAnimationFrame(() => {
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
        }
      });
    }
  }, [messages]);

  // 切换回聊天视图时，自动滚动到底部
  useEffect(() => {
    if (currentView === 'chat' && messagesContainerRef.current) {
      // 使用 setTimeout 确保视图完全渲染后再滚动
      const timer = setTimeout(() => {
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [currentView]);

  /**
   * 处理消息发送（来自 ChatInputBox）
   */
  const handleSubmit = (content: string, attachments?: Attachment[]) => {
    const text = content.trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!text && !hasAttachments) {
      return;
    }
    if (loading) {
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

    if (hasAttachments) {
      try {
        const payload = JSON.stringify({
          text,
          attachments: (attachments || []).map(a => ({
            fileName: a.fileName,
            mediaType: a.mediaType,
            data: a.data,
          }))
        });
        sendBridgeMessage('send_message_with_attachments', payload);
      } catch (error) {
        console.error('[Frontend] Failed to serialize attachments payload', error);
        sendBridgeMessage('send_message', text);
      }
    } else {
      sendBridgeMessage('send_message', text);
    }

    // 清空输入框状态
    setInputValue('');
  };

  /**
   * 处理模式选择
   */
  const handleModeSelect = (mode: PermissionMode) => {
    setPermissionMode(mode);
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

    // 切换 provider 时,同时发送对应的模型
    const newModel = providerId === 'codex' ? selectedCodexModel : selectedClaudeModel;
    sendBridgeMessage('set_model', newModel);
  };

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
    // 移除通知：正在创建新会话...
    // 重置使用量显示为 0%
    setUsagePercentage(0);
    setUsageUsedTokens(0);
    // 保留 maxTokens，等待后端推送；如果此前已知模型，可按默认 272K 预估
    setUsageMaxTokens((prev) => prev ?? 272000);
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
    setUsagePercentage(0);
    setUsageUsedTokens(0);
    setUsageMaxTokens((prev) => prev ?? 272000);
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
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
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
      rejectMessage: 'User denied the permission request',
    });
    console.log('[PERM_DEBUG][FRONTEND] Sending decision payload:', payload);
    sendBridgeMessage('permission_decision', payload);
    console.log('[PERM_DEBUG][FRONTEND] Decision sent, closing dialog');
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

      // 显示成功提示
      addToast('会话已删除', 'success');
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
        return '(空消息)';
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
        return '(空消息)';
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

    if (message.type === 'assistant') {
      return true;
    }
    if (message.type === 'user' || message.type === 'error') {
      // 检查是否有有效的文本内容
      if (text && text.trim() && text !== '(空消息)' && text !== '(无法解析内容)') {
        return true;
      }
      // 检查是否有有效的内容块（如图片等）
      const rawBlocks = normalizeBlocks(message.raw);
      if (Array.isArray(rawBlocks) && rawBlocks.length > 0) {
        // 确保至少有一个非空的内容块
        return rawBlocks.some(block => {
          if (block.type === 'text') {
            return block.text && block.text.trim().length > 0;
          }
          // 图片、工具使用等其他类型的块都应该显示
          return true;
        });
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
            name: typeof candidate.name === 'string' ? (candidate.name as string) : '未知工具',
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
      return rawBlocks;
    }
    if (message.content && message.content.trim()) {
      return [{ type: 'text', text: localizeMessage(message.content) }];
    }
    // 如果没有任何内容，返回空数组而不是显示"(空消息)"
    // shouldShowMessage 会过滤掉这些消息
    return [];
  };

  const findToolResult = (toolUseId?: string, messageIndex?: number): ToolResultBlock | null => {
    if (!toolUseId || typeof messageIndex !== 'number') {
      return null;
    }
    for (let i = messageIndex + 1; i < messages.length; i += 1) {
      const candidate = messages[i];
      if (candidate.type !== 'user') {
        continue;
      }
      const raw = candidate.raw;
      if (!raw || typeof raw === 'string') {
        continue;
      }
      const content = raw.content;
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
  };

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

  const hasThinkingBlockInLastMessage = useMemo(() => {
    if (messages.length === 0) return false;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.type !== 'assistant') return false;
    const blocks = getContentBlocks(lastMessage);
    return blocks.some((b) => b.type === 'thinking');
  }, [messages]);

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
                  onClick={() => setCurrentView('history')}
                  data-tooltip={t('common.history')}
                >
                  <span className="codicon codicon-history" />
                </button>
                <button
                  className="icon-button"
                  onClick={() => setCurrentView('settings')}
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
        <SettingsView onClose={() => setCurrentView('chat')} />
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
                {currentProvider === 'codex' ? (
                  <OpenAI.Avatar size={64} />
                ) : (
                  <Claude.Color size={58} />
                )}
                <span className="version-tag">
                  v0.0.9-beta5
                </span>
              </div>
              <div>{t('chat.sendMessage', { provider: currentProvider === 'codex' ? 'Codex Cli' : 'Claude Code' })}</div>
            </div>
          )}

          {messages.map((message, messageIndex) => {
            if (!shouldShowMessage(message)) {
              return null;
            }

            return (
              <div key={messageIndex} className={`message ${message.type}`}>
                {message.type === 'user' && message.timestamp && (
                  <div className="message-timestamp-header">
                    {formatTime(message.timestamp)}
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
                        {block.type === 'text' && <MarkdownBlock content={block.text ?? ''} />}
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
                            title="点击预览大图"
                          >
                            <img
                              src={block.src}
                              alt="用户上传的图片"
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
                                {isThinking && messageIndex === messages.length - 1
                                  ? t('common.thinking')
                                  : t('common.thinkingProcess')}
                              </span>
                              <span className="thinking-icon">
                                {isThinkingExpanded(messageIndex, blockIndex) ? '▼' : '▶'}
                              </span>
                            </div>
                            {isThinkingExpanded(messageIndex, blockIndex) && (
                              <div className="thinking-content">
                                {block.thinking ?? block.text ?? '(无思考内容)'}
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
                              <EditToolBlock name={block.name} input={block.input} />
                            ) : block.name &&
                              ['bash', 'run_terminal_cmd', 'execute_command'].includes(
                                block.name.toLowerCase(),
                              ) ? (
                              <BashToolBlock
                                name={block.name}
                                input={block.input}
                                result={findToolResult(block.id, messageIndex)}
                              />
                            ) : (
                              <GenericToolBlock name={block.name} input={block.input} />
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
          {isThinking && !hasThinkingBlockInLastMessage && (
            <div className="message assistant">
              <div className="thinking-status">
                <span className="thinking-status-icon">🤔</span>
                <span className="thinking-status-text">{t('common.thinking')}</span>
              </div>
            </div>
          )}

          {/* Loading indicator */}
          {loading && <WaitingIndicator startTime={loadingStartTime ?? undefined} />}
        </div>

        {/* 滚动控制按钮 */}
        <ScrollControl containerRef={messagesContainerRef} inputAreaRef={inputAreaRef} />
      </>
      ) : (
        <HistoryView
          historyData={historyData}
          onLoadSession={loadHistorySession}
          onDeleteSession={deleteHistorySession}
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
            value={inputValue}
            placeholder={t('chat.inputPlaceholder')}
            onSubmit={handleSubmit}
            onStop={interruptSession}
            onInput={setInputValue}
            onModeSelect={handleModeSelect}
            onModelSelect={handleModelSelect}
            onProviderSelect={handleProviderSelect}
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
    </>
  );
};

export default App;
