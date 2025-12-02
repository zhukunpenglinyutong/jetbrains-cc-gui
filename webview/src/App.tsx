import { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownBlock from './components/MarkdownBlock';
import HistoryView from './components/history/HistoryView';
import SettingsView from './components/SettingsView';
import ConfirmDialog from './components/ConfirmDialog';
import PermissionDialog, { type PermissionRequest } from './components/PermissionDialog';
import { ChatInputBox } from './components/ChatInputBox';
import type { Attachment, PermissionMode } from './components/ChatInputBox/types';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  ReadToolBlock,
  TaskExecutionBlock,
  TodoListBlock,
} from './components/toolBlocks';
import { BackIcon, ClawdIcon } from './components/Icons';
import { ToastContainer, type ToastMessage } from './components/Toast';
import WaitingIndicator from './components/WaitingIndicator';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeRawMessage,
  HistoryData,
  TodoItem,
  ToolResultBlock,
} from './types';

type ViewMode = 'chat' | 'history' | 'settings';

const DEFAULT_STATUS = '就绪';

const isTruthy = (value: unknown) => value === true || value === 'true';

const sendBridgeMessage = (event: string, payload = '') => {
  if (window.sendToJava) {
    window.sendToJava(`${event}:${payload}`);
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
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [_status, setStatus] = useState(DEFAULT_STATUS); // Internal state, displayed via toast
  const [loading, setLoading] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [currentView, setCurrentView] = useState<ViewMode>('chat');
  const [historyData, setHistoryData] = useState<HistoryData | null>(null);
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // 权限弹窗状态
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PermissionRequest | null>(null);

  // ChatInputBox 相关状态
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-5');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [usagePercentage, setUsagePercentage] = useState(0);
  const [usageUsedTokens, setUsageUsedTokens] = useState<number | undefined>(undefined);
  const [usageMaxTokens, setUsageMaxTokens] = useState<number | undefined>(undefined);

  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  // 初始化主题
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    const theme = (savedTheme === 'light' || savedTheme === 'dark') ? savedTheme : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
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
    window.showLoading = (value) => setLoading(isTruthy(value));
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
      setSelectedModel(modelId);
    };

    // 权限弹窗回调
    window.showPermissionDialog = (json) => {
      try {
        const request = JSON.parse(json) as PermissionRequest;
        console.log('[Frontend] showPermissionDialog:', request);
        setCurrentPermissionRequest(request);
        setPermissionDialogOpen(true);
      } catch (error) {
        console.error('[Frontend] Failed to parse permission request:', error);
      }
    };
  }, []);

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
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages]);

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
    setSelectedModel(modelId);
    sendBridgeMessage('set_model', modelId);
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

  /**
   * 处理权限批准（允许一次）
   */
  const handlePermissionApprove = (channelId: string) => {
    console.log('[Frontend] Permission approved once:', { channelId });
    sendBridgeMessage('permission_decision', JSON.stringify({
      channelId,
      allow: true,
      remember: false,
      rejectMessage: null,
    }));
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  };

  /**
   * 处理权限批准（总是允许）
   */
  const handlePermissionApproveAlways = (channelId: string) => {
    console.log('[Frontend] Permission approved always:', { channelId });
    sendBridgeMessage('permission_decision', JSON.stringify({
      channelId,
      allow: true,
      remember: true,
      rejectMessage: null,
    }));
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  };

  /**
   * 处理权限拒绝
   */
  const handlePermissionSkip = (channelId: string) => {
    console.log('[Frontend] Permission denied:', { channelId });
    sendBridgeMessage('permission_decision', JSON.stringify({
      channelId,
      allow: false,
      remember: false,
      rejectMessage: 'User denied the permission request',
    }));
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

  const getMessageText = (message: ClaudeMessage) => {
    if (message.content) {
      return message.content;
    }
    const raw = message.raw;
    if (!raw) {
      return '(空消息)';
    }
    if (typeof raw === 'string') {
      return raw;
    }
    if (typeof raw.content === 'string') {
      return raw.content;
    }
    if (Array.isArray(raw.content)) {
      return raw.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    }
    if (raw.message?.content && Array.isArray(raw.message.content)) {
      return raw.message.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    }
    return '(空消息)';
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
          blocks.push({
            type: 'text',
            text: typeof candidate.text === 'string' ? candidate.text : '',
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
        return [{ type: 'text' as const, text: content }];
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
          return [{ type: 'text' as const, text: raw.text }];
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
      return [{ type: 'text', text: message.content }];
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
      return '新会话';
    }
    const firstUserMessage = messages.find((message) => message.type === 'user');
    if (!firstUserMessage) {
      return '新会话';
    }
    const text = getMessageText(firstUserMessage);
    return text.length > 15 ? `${text.substring(0, 15)}...` : text;
  }, [messages]);

  return (
    <>
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
      <div className="header">
        <div className="header-left">
          {currentView === 'history' ? (
            <button className="back-button" onClick={() => setCurrentView('chat')} data-tooltip="返回聊天">
              <BackIcon /> 返回
            </button>
          ) : (
            <div
              className="session-title"
              style={{
                fontWeight: 600,
                fontSize: '14px',
                color: '#e0e0e0',
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
              <button className="icon-button" onClick={createNewSession} data-tooltip="新会话">
                <span className="codicon codicon-plus" />
              </button>
              <button
                className="icon-button"
                onClick={() => setCurrentView('history')}
                data-tooltip="历史记录"
              >
                <span className="codicon codicon-history" />
              </button>
              <button
                className="icon-button"
                onClick={() => setCurrentView('settings')}
                data-tooltip="设置"
              >
                <span className="codicon codicon-settings-gear" />
              </button>
            </>
          )}
        </div>
      </div>

      {currentView === 'settings' ? (
        <SettingsView onClose={() => setCurrentView('chat')} />
      ) : currentView === 'chat' ? (
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
              <div
                style={{
                  width: '64px',
                  height: '64px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ClawdIcon />
              </div>
              <div>给 Claude Code 发送消息</div>
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
                                    <img src="${block.src}" alt="预览" class="image-preview-content" onclick="event.stopPropagation()" />
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
                              <span className="thinking-title">思考过程</span>
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

          {loading && <WaitingIndicator />}
        </div>
      ) : (
        <HistoryView historyData={historyData} onLoadSession={loadHistorySession} />
      )}

      {currentView === 'chat' && (
        <div className="input-area">
          <ChatInputBox
            isLoading={loading}
            selectedModel={selectedModel}
            permissionMode={permissionMode}
            usagePercentage={usagePercentage}
            usageUsedTokens={usageUsedTokens}
            usageMaxTokens={usageMaxTokens}
            showUsage={true}
            onSubmit={handleSubmit}
            onStop={interruptSession}
            onModeSelect={handleModeSelect}
            onModelSelect={handleModelSelect}
          />
        </div>
      )}

      <div id="image-preview-root" />

      <ConfirmDialog
        isOpen={showNewSessionConfirm}
        title="创建新会话"
        message="当前会话已有消息，确定要创建新会话吗？"
        confirmText="确定"
        cancelText="取消"
        onConfirm={handleConfirmNewSession}
        onCancel={handleCancelNewSession}
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
