import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, ChatInputBoxProps, PermissionMode, FileItem, CommandItem } from './types';
import { ButtonArea } from './ButtonArea';
import { AttachmentList } from './AttachmentList';
import { ContextBar } from './ContextBar';
import { CompletionDropdown } from './Dropdown';
import { useTriggerDetection, useCompletionDropdown } from './hooks';
import {
  fileReferenceProvider,
  fileToDropdownItem,
  slashCommandProvider,
  commandToDropdownItem,
} from './providers';
import './styles.css';

/**
 * ChatInputBox - 聊天输入框组件
 * 使用 contenteditable div 实现，支持自动高度调整、IME 处理、@ 文件引用、/ 斜杠命令
 */
export const ChatInputBox = ({
  isLoading = false,
  selectedModel = 'claude-sonnet-4-5',
  permissionMode = 'default',
  currentProvider = 'claude',
  usagePercentage = 0,
  usageUsedTokens,
  usageMaxTokens,
  showUsage = true,
  attachments: externalAttachments,
  placeholder = '@引用文件，shift + enter 换行',
  disabled = false,
  value,
  onSubmit,
  onStop,
  onInput,
  onAddAttachment,
  onRemoveAttachment,
  onModeSelect,
  onModelSelect,
  onProviderSelect,
  activeFile,
  selectedLines,
  onClearContext,
}: ChatInputBoxProps) => {
  // 内部附件状态（如果外部未提供）
  const [internalAttachments, setInternalAttachments] = useState<Attachment[]>([]);
  const attachments = externalAttachments ?? internalAttachments;

  // 输入框引用和状态
  const editableRef = useRef<HTMLDivElement>(null);
  const submittedOnEnterRef = useRef(false);
  const completionSelectedRef = useRef(false); // 标记补全菜单刚选中项目，防止回车同时发送消息
  const [isComposing, setIsComposing] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const compositionTimeoutRef = useRef<number | null>(null);
  const lastCompositionEndTimeRef = useRef<number>(0);

  // 触发检测 Hook
  const { detectTrigger, getTriggerPosition, getCursorPosition } = useTriggerDetection();

  // 文件引用补全 Hook
  const fileCompletion = useCompletionDropdown<FileItem>({
    trigger: '@',
    provider: fileReferenceProvider,
    toDropdownItem: fileToDropdownItem,
    onSelect: (file, query) => {
      if (!editableRef.current || !query) return;

      const text = getTextContent();
      // 文件夹不加空格（方便继续输入路径），文件加空格
      const replacement = file.type === 'directory' ? `@${file.path}` : `@${file.path} `;
      const newText = fileCompletion.replaceText(text, replacement, query);

      // 更新输入框内容
      editableRef.current.innerText = newText;

      // 设置光标到插入文本末尾
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(editableRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);

      handleInput();
    },
  });

  // 斜杠命令补全 Hook
  const commandCompletion = useCompletionDropdown<CommandItem>({
    trigger: '/',
    provider: slashCommandProvider,
    toDropdownItem: commandToDropdownItem,
    onSelect: (command, query) => {
      if (!editableRef.current || !query) return;

      const text = getTextContent();
      const replacement = `${command.label} `;
      const newText = commandCompletion.replaceText(text, replacement, query);

      // 更新输入框内容
      editableRef.current.innerText = newText;

      // 设置光标到插入文本末尾
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(editableRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);

      handleInput();
    },
  });

  /**
   * 获取输入框纯文本内容
   * 注意：在某些浏览器/环境（如 JCEF）中，innerText 可能在末尾包含换行符
   * 这里统一去除末尾的换行符，确保获取的内容干净
   */
  const getTextContent = useCallback(() => {
    const text = editableRef.current?.innerText || '';
    // 去除末尾的换行符（\n, \r, \r\n）
    return text.replace(/[\r\n]+$/, '');
  }, []);

  /**
   * 清空输入框
   */
  const clearInput = useCallback(() => {
    if (editableRef.current) {
      editableRef.current.innerText = '';
      editableRef.current.style.height = 'auto';
      setHasContent(false);
    }
  }, []);

  /**
   * 调整输入框高度
   */
  const adjustHeight = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;

    // 重置高度以获取正确的 scrollHeight
    el.style.height = 'auto';
    const computed = window.getComputedStyle(el);
    const lineHeightStr = computed.lineHeight;
    const lineHeight = parseFloat(lineHeightStr);
    const minHeight = isNaN(lineHeight) ? 60 : lineHeight * 3;

    const newHeight = Math.max(minHeight, Math.min(el.scrollHeight, 240));
    el.style.height = `${newHeight}px`;

    el.style.overflowY = el.scrollHeight > 240 ? 'auto' : 'hidden';
  }, []);

  /**
   * 检测并处理补全触发
   */
  const detectAndTriggerCompletion = useCallback(() => {
    if (!editableRef.current) return;

    const text = getTextContent();
    const cursorPos = getCursorPosition(editableRef.current);
    const trigger = detectTrigger(text, cursorPos);

    // 关闭当前打开的补全
    if (!trigger) {
      fileCompletion.close();
      commandCompletion.close();
      return;
    }

    // 获取触发位置
    const position = getTriggerPosition(editableRef.current, trigger.start);
    if (!position) return;

    // 根据触发符号打开对应的补全
    if (trigger.trigger === '@') {
      commandCompletion.close();
      if (!fileCompletion.isOpen) {
        fileCompletion.open(position, trigger);
        fileCompletion.updateQuery(trigger);
      } else {
        fileCompletion.updateQuery(trigger);
      }
    } else if (trigger.trigger === '/') {
      fileCompletion.close();
      if (!commandCompletion.isOpen) {
        commandCompletion.open(position, trigger);
        commandCompletion.updateQuery(trigger);
      } else {
        commandCompletion.updateQuery(trigger);
      }
    }
  }, [
    getTextContent,
    getCursorPosition,
    detectTrigger,
    getTriggerPosition,
    fileCompletion,
    commandCompletion,
  ]);

  /**
   * 处理输入事件
   */
  const handleInput = useCallback(() => {
    const text = getTextContent();
    const isEmpty = !text.trim();
    setHasContent(!isEmpty);

    // 调整高度
    adjustHeight();

    // 检测补全触发
    detectAndTriggerCompletion();

    // 通知父组件
    onInput?.(text);
  }, [getTextContent, adjustHeight, detectAndTriggerCompletion, onInput]);

  /**
   * 处理提交
   */
  const handleSubmit = useCallback(() => {
    const content = getTextContent().trim();
    console.log('[ChatInputBox] handleSubmit called, content:', content, 'attachments:', attachments.length);

    if (!content && attachments.length === 0) {
      console.log('[ChatInputBox] No content or attachments, returning');
      return;
    }
    if (isLoading) {
      console.log('[ChatInputBox] isLoading, returning');
      return;
    }

    // 关闭补全菜单
    fileCompletion.close();
    commandCompletion.close();

    console.log('[ChatInputBox] Calling onSubmit');
    onSubmit?.(content, attachments.length > 0 ? attachments : undefined);

    // 清空输入框
    clearInput();

    // 如果使用内部附件状态，也清空附件
    if (externalAttachments === undefined) {
      setInternalAttachments([]);
    }
  }, [
    getTextContent,
    attachments,
    isLoading,
    onSubmit,
    clearInput,
    externalAttachments,
    fileCompletion,
    commandCompletion,
  ]);

  /**
   * 处理 Mac 风格的光标移动、文本选择和删除操作
   */
  const handleMacCursorMovement = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!editableRef.current) return false;

    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return false;

    const range = selection.getRangeAt(0);
    const isShift = e.shiftKey;

    // Cmd + Backspace：删除从光标到行首的内容
    if (e.key === 'Backspace' && e.metaKey) {
      e.preventDefault();

      const node = range.startContainer;
      const offset = range.startOffset;

      // 如果有选中内容，直接使用 execCommand 删除（支持撤销）
      if (!range.collapsed) {
        document.execCommand('delete', false);
        handleInput();
        return true;
      }

      // 没有选中内容，先选择从光标到行首的内容，再删除
      // 找到当前行的开始位置
      let lineStartOffset = 0;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        // 从当前位置向前查找换行符
        for (let i = offset - 1; i >= 0; i--) {
          if (text[i] === '\n') {
            lineStartOffset = i + 1;
            break;
          }
        }
      }

      // 如果光标已经在行首，不做任何操作
      if (lineStartOffset === offset) {
        return true;
      }

      // 选择从行首到当前光标的内容
      const newRange = document.createRange();
      newRange.setStart(node, lineStartOffset);
      newRange.setEnd(node, offset);
      selection.removeAllRanges();
      selection.addRange(newRange);

      // 使用 execCommand 删除选中内容（支持撤销）
      document.execCommand('delete', false);

      // 触发 input 事件以更新状态
      handleInput();
      return true;
    }

    // Cmd + 左箭头：移动到行首（或选择到行首）
    if (e.key === 'ArrowLeft' && e.metaKey) {
      e.preventDefault();

      const node = range.startContainer;
      const offset = range.startOffset;

      // 找到当前行的开始位置
      let lineStartOffset = 0;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        // 从当前位置向前查找换行符
        for (let i = offset - 1; i >= 0; i--) {
          if (text[i] === '\n') {
            lineStartOffset = i + 1;
            break;
          }
        }
      }

      const newRange = document.createRange();
      newRange.setStart(node, lineStartOffset);

      if (isShift) {
        // Shift: 选择到行首
        newRange.setEnd(range.endContainer, range.endOffset);
      } else {
        // 无 Shift: 移动光标到行首
        newRange.collapse(true);
      }

      selection.removeAllRanges();
      selection.addRange(newRange);
      return true;
    }

    // Cmd + 右箭头：移动到行尾（或选择到行尾）
    if (e.key === 'ArrowRight' && e.metaKey) {
      e.preventDefault();

      const node = range.endContainer;
      const offset = range.endOffset;

      // 找到当前行的结束位置
      let lineEndOffset = node.textContent?.length || 0;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        // 从当前位置向后查找换行符
        for (let i = offset; i < text.length; i++) {
          if (text[i] === '\n') {
            lineEndOffset = i;
            break;
          }
        }
      }

      const newRange = document.createRange();

      if (isShift) {
        // Shift: 选择到行尾
        newRange.setStart(range.startContainer, range.startOffset);
        newRange.setEnd(node, lineEndOffset);
      } else {
        // 无 Shift: 移动光标到行尾
        newRange.setStart(node, lineEndOffset);
        newRange.collapse(true);
      }

      selection.removeAllRanges();
      selection.addRange(newRange);
      return true;
    }

    // Cmd + 上箭头：移动到文本开头（或选择到开头）
    if (e.key === 'ArrowUp' && e.metaKey) {
      e.preventDefault();

      const firstNode = editableRef.current.firstChild || editableRef.current;
      const newRange = document.createRange();

      if (isShift) {
        // Shift: 选择到开头
        newRange.setStart(firstNode, 0);
        newRange.setEnd(range.endContainer, range.endOffset);
      } else {
        // 无 Shift: 移动光标到开头
        newRange.setStart(firstNode, 0);
        newRange.collapse(true);
      }

      selection.removeAllRanges();
      selection.addRange(newRange);
      return true;
    }

    // Cmd + 下箭头：移动到文本末尾（或选择到末尾）
    if (e.key === 'ArrowDown' && e.metaKey) {
      e.preventDefault();

      const lastNode = editableRef.current.lastChild || editableRef.current;
      const lastOffset = lastNode.nodeType === Node.TEXT_NODE
        ? (lastNode.textContent?.length || 0)
        : lastNode.childNodes.length;

      const newRange = document.createRange();

      if (isShift) {
        // Shift: 选择到末尾
        newRange.setStart(range.startContainer, range.startOffset);
        newRange.setEnd(lastNode, lastOffset);
      } else {
        // 无 Shift: 移动光标到末尾
        newRange.setStart(lastNode, lastOffset);
        newRange.collapse(true);
      }

      selection.removeAllRanges();
      selection.addRange(newRange);
      return true;
    }

    return false;
  }, []);

  /**
   * 处理键盘事件
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // 检测 IME 组合状态（多种方式）
    // keyCode 229 是 IME 输入时的特殊代码
    // nativeEvent.isComposing 是原生事件的组合状态
    const isIMEComposing = isComposing || e.nativeEvent.isComposing;

    const isEnterKey =
      e.key === 'Enter' ||
      (e as unknown as { keyCode?: number }).keyCode === 13 ||
      (e.nativeEvent as unknown as { keyCode?: number }).keyCode === 13 ||
      (e as unknown as { which?: number }).which === 13;

    console.log('[ChatInputBox] handleKeyDown:', e.key,
      'shiftKey:', e.shiftKey,
      'isComposing:', isComposing,
      'nativeIsComposing:', e.nativeEvent.isComposing,
      'isIMEComposing:', isIMEComposing);

    // 优先处理 Mac 风格的光标移动和文本选择
    if (handleMacCursorMovement(e)) {
      return;
    }

    // 允许其他光标移动快捷键（Home/End/Ctrl+A/Ctrl+E）
    const isCursorMovementKey =
      e.key === 'Home' ||
      e.key === 'End' ||
      ((e.key === 'a' || e.key === 'A') && e.ctrlKey && !e.metaKey) || // Ctrl+A (Linux/Windows)
      ((e.key === 'e' || e.key === 'E') && e.ctrlKey && !e.metaKey);   // Ctrl+E (Linux/Windows)

    if (isCursorMovementKey) {
      // 允许默认的光标移动行为
      return;
    }

    // 优先处理补全菜单的键盘事件
    if (fileCompletion.isOpen) {
      const handled = fileCompletion.handleKeyDown(e.nativeEvent);
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        // 如果是回车键选中，标记防止后续发送消息
        if (e.key === 'Enter') {
          completionSelectedRef.current = true;
        }
        return;
      }
    }

    if (commandCompletion.isOpen) {
      const handled = commandCompletion.handleKeyDown(e.nativeEvent);
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        // 如果是回车键选中，标记防止后续发送消息
        if (e.key === 'Enter') {
          completionSelectedRef.current = true;
        }
        return;
      }
    }

    // 检查是否刚刚结束组合输入（防止 IME 确认时的回车误触）
    // 如果 compositionend 和 keydown 间隔很短，说明这个 keydown 可能是 IME 确认的回车
    const isRecentlyComposing = Date.now() - lastCompositionEndTimeRef.current < 100;

    // Enter 发送（非 Shift 组合，非 IME 组合）
    if (isEnterKey && !e.shiftKey && !isIMEComposing && !isRecentlyComposing) {
      console.log('[ChatInputBox] Enter pressed, calling handleSubmit');
      e.preventDefault();
      submittedOnEnterRef.current = true;
      handleSubmit();
      return;
    }

    // Shift+Enter 允许换行（默认行为）
  }, [isComposing, handleSubmit, fileCompletion, commandCompletion]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const isEnterKey =
      e.key === 'Enter' ||
      (e as unknown as { keyCode?: number }).keyCode === 13 ||
      (e.nativeEvent as unknown as { keyCode?: number }).keyCode === 13 ||
      (e as unknown as { which?: number }).which === 13;

    if (isEnterKey && !e.shiftKey) {
      e.preventDefault();
      // 如果刚刚在补全菜单中选中了项目，不发送消息
      if (completionSelectedRef.current) {
        completionSelectedRef.current = false;
        return;
      }
      if (submittedOnEnterRef.current) {
        submittedOnEnterRef.current = false;
        return;
      }
      if (!fileCompletion.isOpen && !commandCompletion.isOpen) {
        // 不在 keyup 中处理发送逻辑，统一由 keydown 处理，避免 IME 状态下的误发送
      }
    }
  }, [isComposing, handleSubmit, fileCompletion, commandCompletion]);

  // 受控模式：当外部 value 改变时更新输入框内容
  useEffect(() => {
    if (value === undefined) return;
    if (!editableRef.current) return;

    const currentText = getTextContent();
    // 仅当外部值与当前值不同时更新，避免光标跳动
    if (currentText !== value) {
      editableRef.current.innerText = value;
      setHasContent(!!value.trim());
      adjustHeight();

      // 将光标移到末尾
      if (value) {
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(editableRef.current);
        range.collapse(false); // false = 折叠到末尾
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }, [value, getTextContent, adjustHeight]);

  // 原生事件捕获，兼容 JCEF/IME 的特殊行为
  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;

    const nativeKeyDown = (ev: KeyboardEvent) => {
      const isEnterKey =
        ev.key === 'Enter' ||
        (ev as unknown as { keyCode?: number }).keyCode === 13 ||
        (ev as unknown as { which?: number }).which === 13;

      const shift = (ev as KeyboardEvent).shiftKey === true;

      // Mac 风格的光标移动快捷键和删除操作（已在 React 事件中处理，这里不需要处理）
      const isMacCursorMovementOrDelete =
        (ev.key === 'ArrowLeft' && ev.metaKey) ||
        (ev.key === 'ArrowRight' && ev.metaKey) ||
        (ev.key === 'ArrowUp' && ev.metaKey) ||
        (ev.key === 'ArrowDown' && ev.metaKey) ||
        (ev.key === 'Backspace' && ev.metaKey);

      if (isMacCursorMovementOrDelete) {
        // Mac 快捷键已在 React 事件中处理
        return;
      }

      // 允许其他光标移动快捷键（Home/End/Ctrl+A/Ctrl+E）
      const isCursorMovementKey =
        ev.key === 'Home' ||
        ev.key === 'End' ||
        ((ev.key === 'a' || ev.key === 'A') && ev.ctrlKey && !ev.metaKey) ||
        ((ev.key === 'e' || ev.key === 'E') && ev.ctrlKey && !ev.metaKey);

      if (isCursorMovementKey) {
        // 允许默认的光标移动行为
        return;
      }

      // 补全菜单打开时，不在原生事件中处理（React onKeyDown 已处理，避免重复）
      if (fileCompletion.isOpen || commandCompletion.isOpen) {
        return;
      }

      // 检查是否刚刚结束组合输入
      const isRecentlyComposing = Date.now() - lastCompositionEndTimeRef.current < 100;

      if (isEnterKey && !shift && !isComposing && !isRecentlyComposing) {
        ev.preventDefault();
        submittedOnEnterRef.current = true;
        handleSubmit();
      }
    };

    const nativeKeyUp = (ev: KeyboardEvent) => {
      const isEnterKey =
        ev.key === 'Enter' ||
        (ev as unknown as { keyCode?: number }).keyCode === 13 ||
        (ev as unknown as { which?: number }).which === 13;
      const shift = (ev as KeyboardEvent).shiftKey === true;
      if (isEnterKey && !shift) {
        ev.preventDefault();
        // 如果刚刚在补全菜单中选中了项目，不发送消息
        if (completionSelectedRef.current) {
          completionSelectedRef.current = false;
          return;
        }
        if (submittedOnEnterRef.current) {
          submittedOnEnterRef.current = false;
          return;
        }
        if (!fileCompletion.isOpen && !commandCompletion.isOpen) {
          // 不在 keyup 中处理发送逻辑，统一由 keydown 处理
        }
      }
    };

    const nativeBeforeInput = (ev: InputEvent) => {
      const type = (ev as InputEvent).inputType;
      if (type === 'insertParagraph') {
        ev.preventDefault();
	        // 如果刚刚在补全菜单中用回车选择了项目，则不发送消息
	        if (completionSelectedRef.current) {
	          completionSelectedRef.current = false;
	          return;
	        }
	        // 补全菜单打开时不发送消息
	        if (fileCompletion.isOpen || commandCompletion.isOpen) {
	          return;
	        }
	        handleSubmit();
      }
    };

    el.addEventListener('keydown', nativeKeyDown, { capture: true });
    el.addEventListener('keyup', nativeKeyUp, { capture: true });
    el.addEventListener('beforeinput', nativeBeforeInput as EventListener, { capture: true });

    return () => {
      el.removeEventListener('keydown', nativeKeyDown, { capture: true } as any);
      el.removeEventListener('keyup', nativeKeyUp, { capture: true } as any);
      el.removeEventListener('beforeinput', nativeBeforeInput as EventListener, { capture: true } as any);
    };
  }, [isComposing, handleSubmit, fileCompletion, commandCompletion]);

  /**
   * 处理 IME 组合开始
   */
  const handleCompositionStart = useCallback(() => {
    // 清除之前的超时
    if (compositionTimeoutRef.current) {
      clearTimeout(compositionTimeoutRef.current);
      compositionTimeoutRef.current = null;
    }
    setIsComposing(true);
  }, []);

  /**
   * 处理 IME 组合结束
   */
  const handleCompositionEnd = useCallback(() => {
    lastCompositionEndTimeRef.current = Date.now();
    // 使用 setTimeout 延迟重置，确保在 keydown 之后执行
    // 这可以防止在某些环境下 compositionend 和 keydown 的时序问题
    compositionTimeoutRef.current = window.setTimeout(() => {
      setIsComposing(false);
      compositionTimeoutRef.current = null;
    }, 10);
  }, []);

  /**
   * 生成唯一 ID（兼容 JCEF）
   */
  const generateId = useCallback(() => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // 后备方案：使用时间戳 + 随机数
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }, []);

  /**
   * 处理粘贴事件 - 检测图片和纯文本
   */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    console.log('[ChatInputBox] ========== handlePaste START ==========');
    const items = e.clipboardData?.items;
    console.log('[ChatInputBox] clipboardData items count:', items?.length);

    if (!items) {
      console.log('[ChatInputBox] No clipboard items, allowing default paste');
      return;
    }

    // 打印所有 clipboard items 的详细信息
    console.log('[ChatInputBox] All clipboard items:');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log(`  [${i}] type: "${item.type}", kind: "${item.kind}"`);
    }

    // 尝试从多种格式获取文本内容
    const plainText = e.clipboardData.getData('text/plain');
    const uriList = e.clipboardData.getData('text/uri-list');

    console.log('[ChatInputBox] Plain text available:', plainText ? `yes (${plainText.length} chars)` : 'no');
    console.log('[ChatInputBox] URI list available:', uriList ? `yes (${uriList.length} chars)` : 'no');

    // 检查是否有真正的图片（type 为 image/*）
    let hasImage = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // 只处理真正的图片类型（type 以 image/ 开头）
      if (item.type.startsWith('image/')) {
        console.log('[ChatInputBox] Found image item at index', i, ', type:', item.type);
        hasImage = true;
        e.preventDefault();

        const blob = item.getAsFile();
        console.log('[ChatInputBox] Got blob:', blob ? 'yes' : 'no', blob ? `size: ${blob.size}` : '');

        if (blob) {
          // 读取图片为 Base64
          const reader = new FileReader();
          reader.onload = () => {
            console.log('[ChatInputBox] Image loaded, result length:', (reader.result as string)?.length);
            const base64 = (reader.result as string).split(',')[1];
            const mediaType = blob.type || item.type || 'image/png';
            const ext = (() => {
              if (mediaType && mediaType.includes('/')) {
                return mediaType.split('/')[1];
              }
              const name = blob.name || '';
              const m = name.match(/\.([a-zA-Z0-9]+)$/);
              return m ? m[1] : 'png';
            })();
            const attachment: Attachment = {
              id: generateId(),
              fileName: `pasted-image-${Date.now()}.${ext}`,
              mediaType,
              data: base64,
            };
            console.log('[ChatInputBox] Created attachment:', attachment.fileName);

            setInternalAttachments(prev => {
              console.log('[ChatInputBox] Adding image attachment, prev count:', prev.length);
              return [...prev, attachment];
            });
          };
          reader.onerror = (error) => {
            console.error('[ChatInputBox] FileReader error:', error);
          };
          reader.readAsDataURL(blob);
        }

        console.log('[ChatInputBox] ========== handlePaste END (image) ==========');
        return;
      }
    }

    // 如果没有图片，尝试获取文本或文件路径
    if (!hasImage) {
      console.log('[ChatInputBox] No image found, trying to get text or file path');
      e.preventDefault();

      // 尝试多种方式获取文本
      let text = e.clipboardData.getData('text/plain') ||
                 e.clipboardData.getData('text/uri-list') ||
                 e.clipboardData.getData('text/html');

      // 如果还是没有文本，尝试从 file 类型的 item 中获取文件名/路径
      if (!text) {
        console.log('[ChatInputBox] No text data, trying to get from file items');

        // 检查是否有文件类型的 item
        let hasFileItem = false;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === 'file') {
            hasFileItem = true;
            const file = item.getAsFile();
            if (file) {
              console.log('[ChatInputBox] Got file from clipboard:', file.name, file.type, file.size);
            }
            break;
          }
        }

        // 如果有文件类型的 item，尝试通过 Java 端获取完整路径
        if (hasFileItem && (window as any).getClipboardFilePath) {
          console.log('[ChatInputBox] Requesting full path from Java...');
          (window as any).getClipboardFilePath().then((fullPath: string) => {
            console.log('[ChatInputBox] Received full path from Java:', fullPath);
            if (fullPath && fullPath.trim()) {
              // 插入完整路径
              document.execCommand('insertText', false, fullPath);
              handleInput();
            }
          }).catch((error: any) => {
            console.error('[ChatInputBox] Error getting clipboard path:', error);
          });
          console.log('[ChatInputBox] ========== handlePaste END (async path request) ==========');
          return;
        }
      }

      console.log('[ChatInputBox] Final text to insert, length:', text ? text.length : 0);

      if (text && text.trim()) {
        // 使用 document.execCommand 插入纯文本（保持光标位置）
        const success = document.execCommand('insertText', false, text);
        console.log('[ChatInputBox] execCommand insertText result:', success);

        // 触发 input 事件以更新状态
        handleInput();
      } else {
        console.log('[ChatInputBox] No text to insert');
      }
    }

    console.log('[ChatInputBox] ========== handlePaste END ==========');
  }, [generateId, handleInput]);

  /**
   * 处理拖拽进入事件
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 设置拖拽效果为复制
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  /**
   * 处理拖拽释放事件 - 检测图片和文件路径
   */
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    console.log('[ChatInputBox] handleDrop called');

    // 先获取文本内容（文件路径）
    const text = e.dataTransfer?.getData('text/plain');
    console.log('[ChatInputBox] Drop text:', text);

    // 再检查文件对象
    const files = e.dataTransfer?.files;
    console.log('[ChatInputBox] Drop files count:', files?.length);

    // 检查是否有实际的图片文件对象
    let hasImageFile = false;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        console.log('[ChatInputBox] Drop file', i, '- type:', file.type, ', name:', file.name, ', size:', file.size);

        // 只处理图片文件
        if (file.type.startsWith('image/')) {
          hasImageFile = true;
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = (reader.result as string).split(',')[1];
            const ext = (() => {
              if (file.type && file.type.includes('/')) {
                return file.type.split('/')[1];
              }
              const m = file.name.match(/\.([a-zA-Z0-9]+)$/);
              return m ? m[1] : 'png';
            })();
            const attachment: Attachment = {
              id: generateId(),
              fileName: file.name || `dropped-image-${Date.now()}.${ext}`,
              mediaType: file.type || 'image/png',
              data: base64,
            };
            console.log('[ChatInputBox] Created attachment from drop:', attachment.fileName);

            setInternalAttachments(prev => [...prev, attachment]);
          };
          reader.onerror = (error) => {
            console.error('[ChatInputBox] FileReader error:', error);
          };
          reader.readAsDataURL(file);
        }
      }
    }

    // 如果有图片文件，不处理文本
    if (hasImageFile) {
      console.log('[ChatInputBox] Has image file, skipping text insertion');
      return;
    }

    // 没有图片文件，处理文本（文件路径或其他文本）
    if (text && text.trim()) {
      console.log('[ChatInputBox] Inserting text (file path or plain text):', text);

      // 获取当前光标位置
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && editableRef.current) {
        // 确保光标在输入框内
        if (editableRef.current.contains(selection.anchorNode)) {
          // 使用 document.execCommand 插入纯文本（保持光标位置）
          document.execCommand('insertText', false, text);
          console.log('[ChatInputBox] Text inserted successfully');
        } else {
          // 光标不在输入框内，直接追加到末尾
          console.log('[ChatInputBox] Cursor not in editable, appending to end');
          const currentText = getTextContent();
          editableRef.current.innerText = currentText + text;

          // 将光标移到末尾
          const range = document.createRange();
          range.selectNodeContents(editableRef.current);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } else {
        // 没有选区，直接追加
        console.log('[ChatInputBox] No selection, appending to end');
        const currentText = getTextContent();
        if (editableRef.current) {
          editableRef.current.innerText = currentText + text;
        }
      }

      // 触发 input 事件以更新状态
      handleInput();
    } else {
      console.log('[ChatInputBox] No text to insert');
    }
  }, [generateId, handleInput, getTextContent]);

  /**
   * 处理添加附件
   */
  const handleAddAttachment = useCallback((files: FileList) => {
    if (externalAttachments !== undefined) {
      onAddAttachment?.(files);
    } else {
      // 使用内部状态
      Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          const attachment: Attachment = {
            id: generateId(),
            fileName: file.name,
            mediaType: file.type || 'application/octet-stream',
            data: base64,
          };
          setInternalAttachments(prev => [...prev, attachment]);
        };
        reader.readAsDataURL(file);
      });
    }
  }, [externalAttachments, onAddAttachment, generateId]);

  /**
   * 处理移除附件
   */
  const handleRemoveAttachment = useCallback((id: string) => {
    if (externalAttachments !== undefined) {
      onRemoveAttachment?.(id);
    } else {
      setInternalAttachments(prev => prev.filter(a => a.id !== id));
    }
  }, [externalAttachments, onRemoveAttachment]);

  /**
   * 处理模式选择
   */
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    onModeSelect?.(mode);
  }, [onModeSelect]);

  /**
   * 处理模型选择
   */
  const handleModelSelect = useCallback((modelId: string) => {
    onModelSelect?.(modelId);
  }, [onModelSelect]);

  /**
   * 聚焦输入框
   */
  const focusInput = useCallback(() => {
    editableRef.current?.focus();
  }, []);

  // 初始化时聚焦和注册全局函数
  useEffect(() => {
    console.log('[ChatInputBox] Component mounted');

    // 注册全局函数以接收 Java 传递的文件路径
    (window as any).handleFilePathFromJava = (filePath: string) => {
      console.log('[ChatInputBox] Received file path from Java:', filePath);

      if (!editableRef.current) return;

      // 插入文件路径到输入框
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && editableRef.current.contains(selection.anchorNode)) {
        // 光标在输入框内，在光标位置插入
        document.execCommand('insertText', false, filePath);
        console.log('[ChatInputBox] File path inserted at cursor position');
      } else {
        // 光标不在输入框内，追加到末尾
        const currentText = getTextContent();
        editableRef.current.innerText = currentText + filePath;
        console.log('[ChatInputBox] File path appended to end');

        // 将光标移到末尾
        const range = document.createRange();
        range.selectNodeContents(editableRef.current);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }

      // 触发 input 事件以更新状态
      handleInput();
    };

    focusInput();

    // 清理函数
    return () => {
      delete (window as any).handleFilePathFromJava;
    };
  }, [focusInput, handlePaste, handleDrop, handleDragOver, handleInput, getTextContent]);

  return (
    <div className="chat-input-box" onClick={focusInput}>
      {/* 附件列表 */}
      {attachments.length > 0 && (
        <AttachmentList
          attachments={attachments}
          onRemove={handleRemoveAttachment}
        />
      )}

      {/* 上下文展示条 (Top Control Bar) */}
      <ContextBar
        activeFile={activeFile}
        selectedLines={selectedLines}
        percentage={usagePercentage}
        usedTokens={usageUsedTokens}
        maxTokens={usageMaxTokens}
        showUsage={showUsage}
        onClearFile={onClearContext}
        onAddAttachment={handleAddAttachment}
      />

      {/* 输入区域 */}
      <div className="input-editable-wrapper">
        <div
          ref={editableRef}
          className="input-editable"
          contentEditable={!disabled}
          data-placeholder={placeholder}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBeforeInput={(e) => {
            const inputType = (e.nativeEvent as unknown as { inputType?: string }).inputType;
            if (inputType === 'insertParagraph') {
              e.preventDefault();
	              // 如果刚刚在补全菜单中用回车选择了项目，则不发送消息
	              if (completionSelectedRef.current) {
	                completionSelectedRef.current = false;
	                return;
	              }
	              // 补全菜单打开时不发送消息
	              if (fileCompletion.isOpen || commandCompletion.isOpen) {
	                return;
	              }
	              // 只有在非加载状态且非输入法组合状态时才允许提交
              if (!isLoading && !isComposing) {
                handleSubmit();
              }
            }
          }}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          suppressContentEditableWarning
        />
      </div>

      {/* 底部工具栏 */}
      <ButtonArea
        disabled={disabled}
        hasInputContent={hasContent || attachments.length > 0}
        isLoading={isLoading}
        selectedModel={selectedModel}
        permissionMode={permissionMode}
        currentProvider={currentProvider}
        onSubmit={handleSubmit}
        onStop={onStop}
        onModeSelect={handleModeSelect}
        onModelSelect={handleModelSelect}
        onProviderSelect={onProviderSelect}
      />

      {/* @ 文件引用下拉菜单 */}
      <CompletionDropdown
        isVisible={fileCompletion.isOpen}
        position={fileCompletion.position}
        items={fileCompletion.items}
        selectedIndex={fileCompletion.activeIndex}
        loading={fileCompletion.loading}
        emptyText="无匹配文件"
        onClose={fileCompletion.close}
        onSelect={(_, index) => fileCompletion.selectIndex(index)}
        onMouseEnter={fileCompletion.handleMouseEnter}
      />

      {/* / 斜杠命令下拉菜单 */}
      <CompletionDropdown
        isVisible={commandCompletion.isOpen}
        position={commandCompletion.position}
        items={commandCompletion.items}
        selectedIndex={commandCompletion.activeIndex}
        loading={commandCompletion.loading}
        emptyText="无匹配命令"
        onClose={commandCompletion.close}
        onSelect={(_, index) => commandCompletion.selectIndex(index)}
        onMouseEnter={commandCompletion.handleMouseEnter}
      />
    </div>
  );
};

export default ChatInputBox;
