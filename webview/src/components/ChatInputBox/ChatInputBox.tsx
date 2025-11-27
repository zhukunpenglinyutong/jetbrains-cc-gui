import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, ChatInputBoxProps, PermissionMode, FileItem, CommandItem } from './types';
import { ButtonArea } from './ButtonArea';
import { AttachmentList } from './AttachmentList';
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
  usagePercentage = 0,
  usageUsedTokens,
  usageMaxTokens,
  showUsage = true,
  attachments: externalAttachments,
  placeholder = '@引用文件，shift + enter 换行',
  disabled = false,
  onSubmit,
  onStop,
  onInput,
  onAddAttachment,
  onRemoveAttachment,
  onModeSelect,
  onModelSelect,
}: ChatInputBoxProps) => {
  // 内部附件状态（如果外部未提供）
  const [internalAttachments, setInternalAttachments] = useState<Attachment[]>([]);
  const attachments = externalAttachments ?? internalAttachments;

  // 输入框引用和状态
  const editableRef = useRef<HTMLDivElement>(null);
  const submittedOnEnterRef = useRef(false);
  const [isComposing, setIsComposing] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const compositionTimeoutRef = useRef<number | null>(null);

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
      const replacement = `@${file.path} `;
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
   */
  const getTextContent = useCallback(() => {
    return editableRef.current?.innerText || '';
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

    // 优先处理补全菜单的键盘事件
    if (fileCompletion.isOpen) {
      const handled = fileCompletion.handleKeyDown(e.nativeEvent);
      if (handled) return;
    }

    if (commandCompletion.isOpen) {
      const handled = commandCompletion.handleKeyDown(e.nativeEvent);
      if (handled) return;
    }

    // Enter 发送（非 Shift 组合，非 IME 组合）
    if (isEnterKey && !e.shiftKey && !isIMEComposing) {
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
      if (submittedOnEnterRef.current) {
        submittedOnEnterRef.current = false;
        return;
      }
      if (!fileCompletion.isOpen && !commandCompletion.isOpen) {
        if (isComposing) {
          // 组合输入刚结束的时序下，延迟到下一个tick再发送
          window.setTimeout(() => {
            handleSubmit();
          }, 0);
        } else {
          handleSubmit();
        }
      }
    }
  }, [isComposing, handleSubmit, fileCompletion, commandCompletion]);

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

      // 补全菜单优先处理
      if (fileCompletion.isOpen) {
        const handled = fileCompletion.handleKeyDown(ev);
        if (handled) return;
      }
      if (commandCompletion.isOpen) {
        const handled = commandCompletion.handleKeyDown(ev);
        if (handled) return;
      }

      if (isEnterKey && !shift && !isComposing) {
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
        if (submittedOnEnterRef.current) {
          submittedOnEnterRef.current = false;
          return;
        }
        if (!fileCompletion.isOpen && !commandCompletion.isOpen) {
          if (isComposing) {
            window.setTimeout(() => {
              handleSubmit();
            }, 0);
          } else {
            handleSubmit();
          }
        }
      }
    };

    const nativeBeforeInput = (ev: InputEvent) => {
      const type = (ev as InputEvent).inputType;
      if (type === 'insertParagraph') {
        ev.preventDefault();
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
   * 处理粘贴事件 - 检测图片
   */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    console.log('[ChatInputBox] handlePaste called');
    const items = e.clipboardData?.items;
    console.log('[ChatInputBox] clipboardData items:', items?.length);

    if (!items) {
      console.log('[ChatInputBox] No clipboard items');
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log('[ChatInputBox] Item', i, 'type:', item.type, 'kind:', item.kind);

      if (item.type.startsWith('image/') || item.kind === 'file') {
        e.preventDefault();
        const blob = item.getAsFile();
        console.log('[ChatInputBox] Got blob:', blob ? 'yes' : 'no', 'size:', blob?.size);

        if (blob) {
          // 读取图片为 Base64
          const reader = new FileReader();
          reader.onload = () => {
            console.log('[ChatInputBox] FileReader onload, result length:', (reader.result as string)?.length);
            const base64 = (reader.result as string).split(',')[1];
            const mediaType = (blob.type && blob.type.startsWith('image/')) ? blob.type : (item.type && item.type.startsWith('image/') ? item.type : 'image/png');
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

            // 始终使用内部状态来添加附件（更可靠）
            setInternalAttachments(prev => {
              console.log('[ChatInputBox] Adding attachment, prev count:', prev.length);
              return [...prev, attachment];
            });
          };
          reader.onerror = (error) => {
            console.error('[ChatInputBox] FileReader error:', error);
          };
          reader.readAsDataURL(blob);
        }
        return;
      }
    }
  }, [generateId]);

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

  // 初始化时聚焦
  useEffect(() => {
    focusInput();
  }, [focusInput]);

  return (
    <div className="chat-input-box" onClick={focusInput}>
      {/* 附件列表 */}
      {attachments.length > 0 && (
        <AttachmentList
          attachments={attachments}
          onRemove={handleRemoveAttachment}
        />
      )}

      {/* 输入区域 */}
      <div className="input-editable-wrapper">
        <div
          ref={editableRef}
          className="input-editable"
          contentEditable={!disabled && !isLoading}
          data-placeholder={placeholder}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBeforeInput={(e) => {
            const inputType = (e.nativeEvent as unknown as { inputType?: string }).inputType;
            if (inputType === 'insertParagraph') {
              e.preventDefault();
              handleSubmit();
            }
          }}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
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
        usagePercentage={usagePercentage}
        usageUsedTokens={usageUsedTokens}
        usageMaxTokens={usageMaxTokens}
        showUsage={showUsage}
        onSubmit={handleSubmit}
        onStop={onStop}
        onAddAttachment={handleAddAttachment}
        onModeSelect={handleModeSelect}
        onModelSelect={handleModelSelect}
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
