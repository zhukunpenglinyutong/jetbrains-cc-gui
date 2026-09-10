import type { TFunction } from 'i18next';
import type { ClaudeContentBlock } from '../../../types';

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

interface AttachmentBlockProps {
  block: Extract<ClaudeContentBlock, { type: 'attachment' }>;
  t: TFunction;
}

export function AttachmentBlock({ block, t }: AttachmentBlockProps) {
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
