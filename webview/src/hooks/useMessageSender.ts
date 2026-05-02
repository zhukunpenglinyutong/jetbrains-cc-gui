import { useCallback, useRef, type RefObject } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import type { ClaudeContentBlock, ClaudeMessage } from '../types';
import type { Attachment, ChatInputBoxHandle, PermissionMode, SelectedAgent } from '../components/ChatInputBox/types';
import type { ViewMode } from './useModelProviderState';

/**
 * Command sets for local handling (shared with App.tsx to avoid duplication)
 */
export const NEW_SESSION_COMMANDS = new Set(['/new', '/clear', '/reset']);
export const RESUME_COMMANDS = new Set(['/resume', '/continue']);
export const PLAN_COMMANDS = new Set(['/plan']);

export interface UseMessageSenderOptions {
  t: TFunction;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  currentProvider: string;
  permissionMode: PermissionMode;
  selectedAgent: SelectedAgent | null;
  sdkStatusLoaded: boolean;
  currentSdkInstalled: boolean;
  sentAttachmentsRef: RefObject<Map<string, Array<{ fileName: string; mediaType: string }>>>;
  chatInputRef: RefObject<ChatInputBoxHandle | null>;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  isUserAtBottomRef: RefObject<boolean>;
  userPausedRef: RefObject<boolean>;
  isStreamingRef: RefObject<boolean>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsInitialTab: React.Dispatch<React.SetStateAction<any>>;
  setCurrentView: React.Dispatch<React.SetStateAction<ViewMode>>;
  forceCreateNewSession: () => void;
  handleModeSelect?: (mode: PermissionMode) => void;
}

const TAB_AUTO_RENAME_MAX_CHARS = 8;
const TAB_AUTO_RENAME_PREFERRED_CHARS = 6;

function getTruncatedTitle(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const chars = Array.from(normalized);
  return chars.slice(0, maxChars).join('');
}

function getCompactTitle(input: string): string {
  const normalized = input.replace(/\s+/g, '').trim();
  if (!normalized) return '';

  const compactRules: Array<{ pattern: RegExp; title: string }> = [
    { pattern: /(标签|tab).*(重命名|改名|标题)|(重命名|改名|标题).*(标签|tab)/i, title: '标签改名' },
    { pattern: /(历史|history).*(补全|completion|自动补全)/i, title: '历史补全' },
    { pattern: /(设置|setting).*(开关|toggle)/i, title: '设置开关' },
    { pattern: /(报错|错误|异常|error).*(修复|解决|fix)/i, title: '报错修复' },
    { pattern: /(界面|ui|页面).*(优化|改版|调整)/i, title: '界面优化' },
    { pattern: /(性能|卡顿|慢|优化)/i, title: '性能优化' },
  ];
  for (const rule of compactRules) {
    if (rule.pattern.test(normalized)) {
      return rule.title;
    }
  }

  const stripped = normalized.replace(/[，。！？；：,.!?:;'"`()[\]{}【】<>《》]/g, '');
  if (!stripped) return '';
  return getTruncatedTitle(stripped, TAB_AUTO_RENAME_PREFERRED_CHARS);
}

const CONTINUE_LIKE_INPUTS = new Set([
  '继续',
  '继续吧',
  '继续下',
  '继续一下',
  '接着',
  '接着做',
  '然后',
  '下一步',
  '继续处理',
  '继续改',
  '继续优化',
  'go on',
  'continue',
]);

const NOISE_PHRASES = [
  '你这个',
  '你帮我',
  '帮我',
  '帮忙',
  '麻烦你',
  '麻烦',
  '请你',
  '请',
  '我想',
  '我要',
  '给我',
  '实现一下',
  '实现下',
  '做一下',
  '做下',
  '处理一下',
  '处理下',
  '优化一下',
  '优化下',
  '修复一下',
  '修复下',
  '精简一下',
  '总结一下',
  '总结下',
  '解释一下',
  '解释下',
  '看一下',
  '看下',
];

const FILE_URI_PATTERN = /file:\/\/\/?[^\s，。！？；,;]+/gi;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\(?:[^\\\s，。！？；,;]+\\)*[^\\\s，。！？；,;]*/g;
const POSIX_OR_RELATIVE_PATH_PATTERN = /(?:\.{0,2}\/)?(?:[\w.-]+\/){2,}[\w.-]+/g;

function stripPathLikeContent(input: string): string {
  return input
    .replace(FILE_URI_PATTERN, ' ')
    .replace(WINDOWS_PATH_PATTERN, ' ')
    .replace(POSIX_OR_RELATIVE_PATH_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPathLikeSegment(segment: string): boolean {
  const text = segment.trim();
  if (!text) return false;
  if (/[A-Za-z]:\\/.test(text)) return true;
  if (/file:\/\//i.test(text)) return true;
  const slashCount = (text.match(/[\\/]/g) || []).length;
  return slashCount >= 2;
}

function isContinueLikeInput(input: string): boolean {
  const normalized = input.replace(/\s+/g, '').toLowerCase();
  if (!normalized) return false;
  if (CONTINUE_LIKE_INPUTS.has(normalized)) return true;
  return (
    normalized.startsWith('继续') ||
    normalized.startsWith('接着') ||
    normalized.startsWith('然后') ||
    normalized.startsWith('下一步')
  );
}

function summarizeRequirementTitle(input: string): string {
  const rawText = input.trim();
  if (!rawText) return '';

  let text = stripPathLikeContent(rawText);
  const intentText = text;

  for (const noise of NOISE_PHRASES) {
    text = text.replaceAll(noise, '');
  }
  text = stripPathLikeContent(text);
  text = text.replace(/\s+/g, ' ').trim();

  const hasDocumentContext = /(文档|文件|readme|markdown|\.md\b)/i.test(rawText) || /(文档|文件|readme|markdown|\.md\b)/i.test(text);
  const asksDocumentMeaning = /(什么意思|什么\s*意思|含义|讲了什么|解读|解释|看不懂)/i.test(rawText);
  const asksDocumentSummary = /(总结|概述|梳理|提炼|归纳)/i.test(rawText);
  const explicitlyMentionsDocMeaning = /(文档意思|文件意思)/i.test(rawText);
  if (hasDocumentContext && (asksDocumentMeaning || asksDocumentSummary || explicitlyMentionsDocMeaning)) {
    return '文档意思';
  }

  // High-priority keyword templates (ensure concise and stable tab names)
  if (/(标签|tab)/i.test(intentText) && /(重命名|改名|标题)/i.test(intentText)) return '标签改名';
  if (/(历史|history)/i.test(intentText) && /(补全|completion|自动补全)/i.test(intentText)) return '历史补全';
  if (/(设置|setting)/i.test(intentText) && /(开关|toggle)/i.test(intentText)) return '设置开关';
  if (/(报错|错误|异常|error)/i.test(intentText) && /(修复|解决|fix)/i.test(intentText)) return '报错修复';
  if (/(报错|错误|异常|error)/i.test(intentText)) return '报错排查';
  if (/(界面|ui|页面)/i.test(intentText) && /(优化|改版|调整)/i.test(intentText)) return '界面优化';
  if (/(性能|卡顿|慢|优化)/i.test(intentText)) return '性能优化';

  // Fallback: choose the most informative segment, then truncate
  const segments = text
    .split(/[，。！？；：,.!?:;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((segment) => !isPathLikeSegment(segment));
  const best = (segments.sort((a, b) => b.length - a.length)[0] || text).trim();
  if (!best) return '';

  const compact = getCompactTitle(best);
  if (!compact) return '';
  return getTruncatedTitle(compact, TAB_AUTO_RENAME_MAX_CHARS);
}

/**
 * Handles message building, validation, and sending to the backend.
 */
export function useMessageSender({
  t,
  addToast,
  currentProvider,
  permissionMode,
  selectedAgent,
  sdkStatusLoaded,
  currentSdkInstalled,
  sentAttachmentsRef,
  chatInputRef,
  messagesContainerRef,
  isUserAtBottomRef,
  userPausedRef,
  isStreamingRef,
  setMessages,
  setLoading,
  setLoadingStartTime,
  setStreamingActive,
  setSettingsInitialTab,
  setCurrentView,
  forceCreateNewSession,
  handleModeSelect,
}: UseMessageSenderOptions) {
  const lastMeaningfulTitleRef = useRef('');
  /**
   * Check if the input is a new session command
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
   * Check for local-handled slash commands (/resume, /plan)
   * Returns true if the command was handled locally
   * Note: This is also checked in App.tsx handleSubmit to bypass loading queue
   */
  const checkLocalCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;
    const command = text.split(/\s+/)[0].toLowerCase();

    // /resume - open history view
    if (RESUME_COMMANDS.has(command)) {
      setCurrentView('history');
      return true;
    }

    // /plan - switch to plan mode (Claude only)
    if (PLAN_COMMANDS.has(command)) {
      if (currentProvider === 'codex') {
        addToast(t('chat.planModeNotAvailableForCodex', { defaultValue: 'Plan mode is not available for Codex provider' }), 'warning');
      } else if (handleModeSelect) {
        handleModeSelect('plan');
        addToast(t('chat.planModeEnabled', { defaultValue: 'Plan mode enabled' }), 'info');
      }
      return true;
    }

    return false;
  }, [setCurrentView, handleModeSelect, currentProvider, addToast, t]);

  /**
   * Check for unimplemented slash commands
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
  }, [t, setMessages]);

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
  }, []);

  /**
   * Send message to backend
   */
  const sendMessageToBackend = useCallback((
    text: string,
    attachments: Attachment[] | undefined,
    agentInfo: { id: string; name: string; prompt?: string } | null,
    fileTagsInfo: { displayPath: string; absolutePath: string }[] | null,
    requestedPermissionMode: PermissionMode
  ) => {
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const effectivePermissionMode: PermissionMode = currentProvider === 'codex' && requestedPermissionMode === 'plan'
      ? 'default'
      : requestedPermissionMode;
    console.debug('[ModeSync][Frontend] send request mode', {
      provider: currentProvider,
      requestedMode: requestedPermissionMode,
      effectiveMode: effectivePermissionMode,
    });

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
          permissionMode: effectivePermissionMode,
        });
        sendBridgeEvent('send_message_with_attachments', payload);
      } catch (error) {
        console.error('[Frontend] Failed to serialize attachments payload', error);
        const fallbackPayload = JSON.stringify({
          text,
          agent: agentInfo,
          fileTags: fileTagsInfo,
          permissionMode: effectivePermissionMode,
        });
        sendBridgeEvent('send_message', fallbackPayload);
      }
    } else {
      const payload = JSON.stringify({
        text,
        agent: agentInfo,
        fileTags: fileTagsInfo,
        permissionMode: effectivePermissionMode,
      });
      sendBridgeEvent('send_message', payload);
    }
  }, [currentProvider]);

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

    // Persist non-image attachment metadata
    const nonImageAttachments = Array.isArray(attachments)
      ? attachments.filter(a => !a.mediaType?.startsWith('image/'))
      : [];
    if (nonImageAttachments.length > 0) {
      const MAX_ATTACHMENT_CACHE_SIZE = 100;
      if (sentAttachmentsRef.current.size >= MAX_ATTACHMENT_CACHE_SIZE) {
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
    userPausedRef.current = false;
    isUserAtBottomRef.current = true;
    requestAnimationFrame(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    });

    // Sync provider setting
    sendBridgeEvent('set_provider', currentProvider);

    // Auto-rename current tab based on latest user requirement.
    // Enabled by default unless explicitly turned off in Other Settings.
    try {
      const autoRenameEnabled = localStorage.getItem('tabAutoRenameEnabled') !== 'false';
      if (autoRenameEnabled && text) {
        let nextTitle = '';
        if (isContinueLikeInput(text)) {
          nextTitle = lastMeaningfulTitleRef.current;
        } else {
          nextTitle = summarizeRequirementTitle(text);
          if (nextTitle) {
            lastMeaningfulTitleRef.current = nextTitle;
          }
        }
        if (nextTitle) {
          sendBridgeEvent('rename_current_tab', JSON.stringify({ title: nextTitle }));
        }
      }
    } catch {
      // Ignore localStorage access errors
    }

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
    sendMessageToBackend(text, attachments, agentInfo, fileTagsInfo, permissionMode);
    sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'answering' }));
  }, [
    sdkStatusLoaded,
    currentSdkInstalled,
    currentProvider,
    permissionMode,
    selectedAgent,
    buildUserContentBlocks,
    sendMessageToBackend,
    addToast,
    t,
  ]);

  /**
   * Handle message submission (from ChatInputBox)
   */
  const handleSubmit = useCallback((content: string, attachments?: Attachment[]) => {
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!text && !hasAttachments) return;

    // Check new session commands
    if (checkNewSessionCommand(text)) return;

    // Check local-handled commands (/resume, /plan)
    if (checkLocalCommand(text)) return;

    // Check for unimplemented commands
    if (checkUnimplementedCommand(text)) return;

    // Execute message
    executeMessage(content, attachments);
  }, [checkNewSessionCommand, checkLocalCommand, checkUnimplementedCommand, executeMessage]);

  /**
   * Interrupt the current session
   */
  const interruptSession = useCallback(() => {
    setLoading(false);
    setLoadingStartTime(null);
    setStreamingActive(false);
    isStreamingRef.current = false;

    sendBridgeEvent('interrupt_session');
  }, []);

  return {
    handleSubmit,
    executeMessage,
    interruptSession,
  };
}
