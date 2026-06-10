import { useState, useCallback, memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ToolResultBlock, CompactSummaryMetadata } from '../../types';

import MarkdownBlock from '../MarkdownBlock';
import CollapsibleTextBlock from '../CollapsibleTextBlock';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  TaskExecutionBlock,
} from '../toolBlocks';
import { EDIT_TOOL_NAMES, BASH_TOOL_NAMES, isToolName, isTransientInternalToolName, normalizeToolName } from '../../utils/toolConstants';
import { TASK_STATUS_COLORS } from '../../utils/messageUtils';

const IMAGE_BLOCK_STYLE: React.CSSProperties = { cursor: 'pointer' };

function normalizeProviderErrorText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function shouldShowProviderErrorSummary(summary: string, details: string | undefined): boolean {
  const normalizedSummary = normalizeProviderErrorText(summary);
  const normalizedDetails = normalizeProviderErrorText(details);
  return Boolean(
    normalizedSummary &&
    (!normalizedDetails || !normalizedDetails.includes(normalizedSummary))
  );
}

function getImageStyle(isUser: boolean): React.CSSProperties {
  return {
    maxWidth: isUser ? '200px' : '100%',
    maxHeight: isUser ? '150px' : 'auto',
    borderRadius: '8px',
    objectFit: 'contain',
  };
}

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

interface CompactSummaryBlockProps {
  block: {
    type: 'compact_summary';
    title: string;
    content: string;
    metadata?: CompactSummaryMetadata;
  };
  t: TFunction;
}

/**
 * Compact summary block - collapsed by default, click/Enter/Space to expand.
 * Memoized to prevent state reset on parent re-renders during streaming.
 * `block.title` is an i18n key resolved via t() at render time.
 */
const CompactSummaryBlock = memo(function CompactSummaryBlock({ block, t }: CompactSummaryBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded(e => !e), []);
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded(prev => !prev);
    }
  }, []);
  const meta = block.metadata;
  const hasMeta = meta && typeof meta.messagesSummarized === 'number';
  const titleText = t(block.title);
  const toggleLabel = expanded ? t('chat.compactSummary.collapse') : t('chat.compactSummary.expand');

  return (
    <div className="compact-summary-block">
      <div
        className="compact-summary-title"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${titleText} — ${toggleLabel}`}
        onClick={toggleExpanded}
        onKeyDown={onKeyDown}
      >
        <span className="compact-summary-icon" aria-hidden="true">●</span>
        <span className="compact-summary-title-text">{titleText}</span>
        <span className="compact-summary-toggle" aria-hidden="true">{expanded ? '▼' : '▶'}</span>
      </div>
      {hasMeta && (
        <div className="compact-summary-metadata">
          <span className="compact-summary-meta-count">
            {t(
              meta.direction === 'from'
                ? 'chat.compactSummary.messagesFrom'
                : 'chat.compactSummary.messagesUpTo',
              { count: meta.messagesSummarized },
            )}
          </span>
          {meta.userContext && (
            <span className="compact-summary-meta-context">
              {t('chat.compactSummary.userContext', { context: meta.userContext })}
            </span>
          )}
        </div>
      )}
      {expanded && block.content && (
        <div className="compact-summary-content">
          <MarkdownBlock content={block.content} />
        </div>
      )}
    </div>
  );
});

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
    const handleImageError = (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      if (img.dataset.fallback) return;
      const src = block.src ?? '';
      // resource_url 失败时尝试降级到原始 src
      if (block.thumbnailSrc && img.src !== src && !src.startsWith('data:')) {
        img.dataset.fallback = 'true';
        img.src = src;
        return;
      }
      img.dataset.fallback = 'failed';
      img.alt = t('chat.imageLoadFailed');
      img.style.display = 'none';
      const placeholder = img.nextElementSibling;
      if (placeholder && placeholder.classList.contains('image-load-failed')) return;
      const span = document.createElement('span');
      span.className = 'image-load-failed';
      span.textContent = t('chat.imageLoadFailed');
      span.style.cssText = 'color:var(--text-secondary);font-size:12px;padding:8px;';
      img.parentElement?.appendChild(span);
    };

    const handleImagePreview = () => {
      const previewRoot = document.getElementById('image-preview-root');
      const previewSrc = block.previewSrc || block.src;
      if (!previewRoot || !previewSrc) return;

      // Clear previous content safely
      previewRoot.innerHTML = '';

      // Create overlay container
      const overlay = document.createElement('div');
      overlay.className = 'image-preview-overlay';
      overlay.onclick = () => overlay.remove();

      // Create image element safely (prevents XSS)
      const img = document.createElement('img');
      img.src = previewSrc;
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
        style={IMAGE_BLOCK_STYLE}
        title={t('chat.clickToPreview')}
      >
        <img
          src={block.thumbnailSrc || block.src}
          alt={t('chat.userUploadedImage')}
          style={getImageStyle(messageType === 'user')}
          onError={handleImageError}
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

  if (block.type === 'provider_error') {
    const summary = block.summary || block.details || t('chat.providerError.fallbackSummary');
    const details = block.details || summary;
    const showSummary = shouldShowProviderErrorSummary(summary, block.details);
    const provider = block.provider || 'codex';
    const metadata: string[] = [t('chat.providerError.provider', { provider })];
    if (block.exitCode !== undefined && block.exitCode !== null) {
      metadata.push(t('chat.providerError.exitCode', { exitCode: block.exitCode }));
    }

    return (
      <div className="provider-error-block">
        <div className="provider-error-header">
          <span className="provider-error-icon" aria-hidden="true">!</span>
          <div className="provider-error-heading">
            <span className="provider-error-title">{t('chat.providerError.title')}</span>
            {showSummary && <span className="provider-error-summary">{summary}</span>}
          </div>
        </div>
        <div className="provider-error-meta">
          {metadata.map((item, index) => (
            <span key={index}>{item}</span>
          ))}
        </div>
        {details && (
          <details className="provider-error-details">
            <summary>{t('chat.providerError.details')}</summary>
            <pre>{details}</pre>
          </details>
        )}
      </div>
    );
  }

  if (block.type === 'thinking') {
    return (
      <div className={`thinking-section${isThinkingExpanded ? ' expanded' : ''}`}>
        <div
          className="thinking-section-header"
          onClick={onToggleThinking}
        >
          <svg className="thinking-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2A2.5 2.5 0 0112 4.5v15a2.5 2.5 0 01-4.96.44 2.5 2.5 0 01-2.96-3.08 3 3 0 01-.34-5.58 2.5 2.5 0 011.32-4.24 2.5 2.5 0 011.98-3A2.5 2.5 0 019.5 2z" />
            <path d="M14.5 2A2.5 2.5 0 0012 4.5v15a2.5 2.5 0 004.96.44 2.5 2.5 0 002.96-3.08 3 3 0 00.34-5.58 2.5 2.5 0 00-1.32-4.24 2.5 2.5 0 00-1.98-3A2.5 2.5 0 0014.5 2z" />
          </svg>
          <span className="thinking-section-label">
            {isThinking && isLastMessage && isLastBlock
              ? t('common.thinkingProcess')
              : t('common.thinking')}
          </span>
          <span className="thinking-section-duration">
            {isThinking && isLastMessage && isLastBlock ? '...' : ''}
          </span>
          <svg className="thinking-section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
        <div className="thinking-section-content">
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
          toolId={block.id}
          isStreaming={isStreaming}
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

  // Compact notification block - renders as header + indented sub-items
  if (block.type === 'compact_notification') {
    return (
      <div className="compact-notification-block">
        <div className="compact-notification-header">
          {block.headerText}
        </div>
        {block.items.length > 0 && (
          <div className="compact-notification-items">
            {block.items.map((item, idx) => (
              <div key={idx} className="compact-notification-item">
                <span className="compact-notification-prefix">⎿</span>
                <span className="compact-notification-text">{item.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Compact summary block - collapsed by default, click to expand
  if (block.type === 'compact_summary') {
    return <CompactSummaryBlock block={block} t={t} />;
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
