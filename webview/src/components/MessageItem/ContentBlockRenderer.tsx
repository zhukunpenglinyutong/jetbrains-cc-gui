import { useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';

import MarkdownBlock from '../MarkdownBlock';
import CollapsibleTextBlock from '../CollapsibleTextBlock';
import { ContextMenu } from '../ContextMenu';
import { ImagePreviewOverlay } from '../ImagePreviewOverlay';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  TaskExecutionBlock,
} from '../toolBlocks';
import { copyImageSelection, useContextMenu } from '../../hooks/useContextMenu.js';
import { EDIT_TOOL_NAMES, BASH_TOOL_NAMES, isToolName, isTransientInternalToolName, normalizeToolName } from '../../utils/toolConstants';
import { TASK_STATUS_COLORS } from '../../utils/messageUtils';

/**
 * Get file icon class (consistent with AttachmentList)
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
 * Get file extension
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
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const previewCtxMenu = useContextMenu();

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
    const closePreview = () => {
      setPreviewSrc(null);
      previewCtxMenu.close();
    };

    const imageContextMenuItems = [
      {
        label: t('contextMenu.copyImage', 'Copy Image'),
        action: () => copyImageSelection(previewCtxMenu.targetImageSrc),
      },
      {
        label: t('contextMenu.closePreview', 'Close Preview'),
        action: closePreview,
      },
    ];

    const handleImagePreview = () => {
      setPreviewSrc(block.src ?? null);
    };

    return (
      <>
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

        {previewSrc && (
          <ImagePreviewOverlay>
            <div
              className="image-preview-overlay"
              onClick={closePreview}
              onKeyDown={(e) => e.key === 'Escape' && closePreview()}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if ((e.target as HTMLElement | null)?.closest('img')) {
                  previewCtxMenu.open(e);
                }
              }}
              tabIndex={0}
            >
              <img
                className="image-preview-content"
                src={previewSrc}
                alt={t('chat.imagePreview')}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  previewCtxMenu.open(e);
                }}
              />
              <button
                className="image-preview-close"
                onClick={closePreview}
                title={t('chat.closePreview')}
              >
                ×
              </button>
            </div>
          </ImagePreviewOverlay>
        )}

        {previewCtxMenu.visible && previewCtxMenu.targetImageSrc && (
          <ContextMenu
            x={previewCtxMenu.x}
            y={previewCtxMenu.y}
            onClose={previewCtxMenu.close}
            items={imageContextMenuItems}
          />
        )}
      </>
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
    const toolName = normalizeToolName(block.name ?? '');

    if (toolName === 'todowrite' || toolName === 'update_plan') {
      return null;
    }

    if (!isStreaming && isTransientInternalToolName(block.name)) {
      return null;
    }

    if (toolName === 'task' || toolName === 'agent' || toolName === 'spawn_agent') {
      return (
        <TaskExecutionBlock
          name={block.name}
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

  // Task notification block - renders as "● summary" with status color
  if (block.type === 'task_notification') {
    // TypeScript narrows block to { type: 'task_notification'; icon: string; summary: string; status: string }
    const statusColor = TASK_STATUS_COLORS[block.status] || 'text';
    return (
      <div className={`task-notification-block task-notification-${statusColor}`}>
        <span className="task-notification-icon">{block.icon}</span>
        <span className="task-notification-summary">{block.summary}</span>
      </div>
    );
  }

  return null;
}
