import { useState } from 'react';
import MarkdownBlock from '../MarkdownBlock';
import CollapsibleTextBlock from '../CollapsibleTextBlock';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  ReadToolBlock,
  TaskExecutionBlock,
  TodoListBlock,
} from '../toolBlocks';
import { extractMarkdownContent, copyToClipboard } from '../../utils/copyUtils';
import { formatTime } from '../../utils/helpers';
import { getMessageText, getContentBlocks } from '../../utils/messageUtils';
import { MessageUsage } from './MessageUsage';
import type { ClaudeMessage, TodoItem, ToolResultBlock } from '../../types';

interface MessageItemProps {
  message: ClaudeMessage;
  messageIndex: number;
  mergedMessagesLength: number;
  streamingActive: boolean;
  isThinking: boolean;
  expandedThinking: Record<string, boolean>;
  onToggleThinking: (messageIndex: number, blockIndex: number) => void;
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
}

export const MessageItem = ({
  message,
  messageIndex,
  mergedMessagesLength,
  streamingActive,
  isThinking,
  expandedThinking,
  onToggleThinking,
  findToolResult,
}: MessageItemProps) => {
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);

  const isLastAssistantMessage = message.type === 'assistant' && messageIndex === mergedMessagesLength - 1;
  const isMessageStreaming = streamingActive && isLastAssistantMessage;

  const isThinkingExpanded = (msgIndex: number, blockIndex: number) =>
    Boolean(expandedThinking[`${msgIndex}_${blockIndex}`]);

  const handleCopyMessage = async () => {
    const content = extractMarkdownContent(message);
    if (!content.trim()) return;

    const success = await copyToClipboard(content);
    if (success) {
      setCopiedMessageIndex(messageIndex);
      setTimeout(() => setCopiedMessageIndex(null), 1500);
    }
  };

  return (
    <div className={`message ${message.type}`}>
      {message.type === 'assistant' && !isMessageStreaming && (
        <button
          className={`message-copy-btn ${copiedMessageIndex === messageIndex ? 'copied' : ''}`}
          onClick={handleCopyMessage}
          title={'Copy message'}
          aria-label={'Copy message'}
        >
          <span className="copy-icon">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 4l0 8a2 2 0 0 0 2 2l8 0a2 2 0 0 0 2 -2l0 -8a2 2 0 0 0 -2 -2l-8 0a2 2 0 0 0 -2 2zm2 0l8 0l0 8l-8 0l0 -8z" fill="currentColor" fillOpacity="0.9"/>
              <path d="M2 2l0 8l-2 0l0 -8a2 2 0 0 1 2 -2l8 0l0 2l-8 0z" fill="currentColor" fillOpacity="0.6"/>
            </svg>
          </span>
          <span className="copy-tooltip">{'Copied!'}</span>
        </button>
      )}
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
                    isStreaming={streamingActive && message.type === 'assistant' && messageIndex === mergedMessagesLength - 1}
                  />
                 )
               )}
              {block.type === 'image' && block.src && (
                <div
                  className={`message-image-block ${message.type === 'user' ? 'user-image' : ''}`}
                  onClick={() => {
                    const previewRoot = document.getElementById('image-preview-root');
                    if (previewRoot && block.src) {
                      previewRoot.innerHTML = `
                        <div class="image-preview-overlay" onclick="this.remove()">
                          <img src="${block.src}" alt="Preview" class="image-preview-content" onclick="event.stopPropagation()" />
                          <div class="image-preview-close" onclick="this.parentElement.remove()">x</div>
                        </div>
                      `;
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                  title={'Click to preview'}
                >
                  <img
                    src={block.src}
                    alt={'User uploaded image'}
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
                    onClick={() => onToggleThinking(messageIndex, blockIndex)}
                  >
                    <span className="thinking-title">
                      {isThinking && messageIndex === mergedMessagesLength - 1
                        ? 'Thinking'
                        : 'Thinking Process'}
                    </span>
                    <span className="thinking-icon">
                      {isThinkingExpanded(messageIndex, blockIndex) ? '\u25BC' : '\u25B6'}
                    </span>
                  </div>
                  {isThinkingExpanded(messageIndex, blockIndex) && (
                    <div className="thinking-content">
                      <MarkdownBlock
                        content={block.thinking ?? block.text ?? 'No thinking content'}
                        isStreaming={streamingActive && message.type === 'assistant' && messageIndex === mergedMessagesLength - 1}
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
      {message.type === 'assistant' && !isMessageStreaming && (
        <MessageUsage raw={message.raw} />
      )}
    </div>
  );
};

export default MessageItem;
