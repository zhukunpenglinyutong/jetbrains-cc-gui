import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';

import MarkdownBlock from '../MarkdownBlock';
import CollapsibleTextBlock from '../CollapsibleTextBlock';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  TaskExecutionBlock,
} from '../toolBlocks';
import { EDIT_TOOL_NAMES, BASH_TOOL_NAMES, isToolName } from '../../utils/toolConstants';

/**
 * 获取文件图标 class（与 AttachmentList 保持一致）
 */
function getFileIcon(mediaType?: string): string {
  if (!mediaType) return 'codicon-file';
  if (mediaType.startsWith('text/')) return 'codicon-file-text';
  if (mediaType.includes('json')) return 'codicon-json';
  if (mediaType.includes('javascript') || mediaType.includes('typescript')) return 'codicon-file-code';
  if (mediaType.includes('pdf')) return 'codicon-file-pdf';
  return 'codicon-file';
}

/**
 * 获取文件扩展名
 */
function getExtension(fileName?: string): string {
  if (!fileName) return '';
  const parts = fileName.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
}

export interface ContentBlockRendererProps {
  block: ClaudeContentBlock;
  messageIndex: number;
  messageType: string;
  isStreaming: boolean;
  isThinkingExpanded: boolean;
  isThinking: boolean;
  isLastMessage: boolean;
  isLastBlock?: boolean;
  t: TFunction;
  onToggleThinking: () => void;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
}

export function ContentBlockRenderer({
  block,
  messageIndex,
  messageType,
  isStreaming,
  isThinkingExpanded,
  isThinking,
  isLastMessage,
  isLastBlock = false,
  t,
  onToggleThinking,
  findToolResult,
}: ContentBlockRendererProps): React.ReactElement | null {
  if (block.type === 'text') {
    return messageType === 'user' ? (
      <CollapsibleTextBlock content={block.text ?? ''} />
    ) : (
      <MarkdownBlock
        content={block.text ?? ''}
        isStreaming={isStreaming}
      />
    );
  }

  if (block.type === 'image' && block.src) {
    const handleImagePreview = () => {
      const previewRoot = document.getElementById('image-preview-root');
      if (!previewRoot || !block.src) return;

      // Clear previous content safely
      previewRoot.innerHTML = '';

      // Create overlay container
      const overlay = document.createElement('div');
      overlay.className = 'image-preview-overlay';
      overlay.onclick = () => overlay.remove();

      // Create image element safely (prevents XSS)
      const img = document.createElement('img');
      img.src = block.src;
      img.alt = t('chat.imagePreview');
      img.className = 'image-preview-content';
      img.onclick = (e) => e.stopPropagation();

      // Create close button
      const closeBtn = document.createElement('div');
      closeBtn.className = 'image-preview-close';
      closeBtn.textContent = '×';
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        overlay.remove();
      };

      overlay.appendChild(img);
      overlay.appendChild(closeBtn);
      previewRoot.appendChild(overlay);
    };

    return (
      <div
        className={`message-image-block ${messageType === 'user' ? 'user-image' : ''}`}
        onClick={handleImagePreview}
        style={{ cursor: 'pointer' }}
        title={t('chat.clickToPreview')}
      >
        <img
          src={block.src}
          alt={t('chat.userUploadedImage')}
          style={{
            maxWidth: messageType === 'user' ? '200px' : '100%',
            maxHeight: messageType === 'user' ? '150px' : 'auto',
            borderRadius: '8px',
            objectFit: 'contain',
          }}
        />
      </div>
    );
  }

  if (block.type === 'attachment') {
    const ext = getExtension(block.fileName);
    const displayName = block.fileName || t('chat.unknownFile');
    return (
      <div className="message-attachment-chip" title={displayName}>
        <span className={`message-attachment-chip-icon codicon ${getFileIcon(block.mediaType)}`} />
        {ext && <span className="message-attachment-chip-ext">{ext}</span>}
        <span className="message-attachment-chip-name">{displayName}</span>
      </div>
    );
  }

  if (block.type === 'thinking') {
    return (
      <div className="thinking-block">
        <div
          className="thinking-header"
          onClick={onToggleThinking}
        >
          <span className="thinking-title">
            {isThinking && isLastMessage && isLastBlock
              ? t('common.thinkingProcess')
              : t('common.thinking')}
          </span>
          <span className="thinking-icon">
            {isThinkingExpanded ? '▼' : '▶'}
          </span>
        </div>
        <div 
          className="thinking-content"
          style={{ display: isThinkingExpanded ? 'block' : 'none' }}
        >
          <MarkdownBlock
            content={block.thinking ?? block.text ?? t('chat.noThinkingContent')}
            isStreaming={isStreaming}
          />
        </div>
      </div>
    );
  }

  if (block.type === 'tool_use') {
    const toolName = block.name?.toLowerCase();

    if (toolName === 'todowrite') {
      return null;
    }

    if (toolName === 'task') {
      return (
        <TaskExecutionBlock
          input={block.input}
          result={findToolResult(block.id, messageIndex)}
        />
      );
    }

    if (isToolName(block.name, EDIT_TOOL_NAMES)) {
      return (
        <EditToolBlock
          name={block.name}
          input={block.input}
          result={findToolResult(block.id, messageIndex)}
          toolId={block.id}
        />
      );
    }

    if (isToolName(block.name, BASH_TOOL_NAMES)) {
      return (
        <BashToolBlock
          name={block.name}
          input={block.input}
          result={findToolResult(block.id, messageIndex)}
          toolId={block.id}
        />
      );
    }

    return (
      <GenericToolBlock
        name={block.name}
        input={block.input}
        result={findToolResult(block.id, messageIndex)}
        toolId={block.id}
      />
    );
  }

  return null;
}
