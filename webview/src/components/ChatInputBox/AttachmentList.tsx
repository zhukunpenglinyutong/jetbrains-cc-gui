import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Attachment, AttachmentListProps } from './types';
import { isImageAttachment } from './types';
import { CopilotIcon } from '../copilotIcons';

/**
 * AttachmentList - Attachment list component
 * Displays image thumbnails or file icons
 */
export const AttachmentList = ({
  attachments,
  onRemove,
  onPreview,
}: AttachmentListProps) => {
  const { t } = useTranslation();
  const [previewImage, setPreviewImage] = useState<Attachment | null>(null);

  /**
   * Handle attachment click
   */
  const handleClick = useCallback((attachment: Attachment) => {
    if (isImageAttachment(attachment)) {
      if (onPreview) {
        onPreview(attachment);
      } else {
        setPreviewImage(attachment);
      }
    }
  }, [onPreview]);

  /**
   * Handle attachment removal
   */
  const handleRemove = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onRemove?.(id);
  }, [onRemove]);

  /**
   * Close preview
   */
  const closePreview = useCallback(() => {
    setPreviewImage(null);
  }, []);

  /**
   * Get file icon
   */
  const getFileIcon = (mediaType: string): string => {
    if (mediaType.startsWith('text/')) return 'codicon-file-text';
    if (mediaType.includes('json')) return 'codicon-json';
    if (mediaType.includes('javascript') || mediaType.includes('typescript')) return 'codicon-file-code';
    if (mediaType.includes('pdf')) return 'codicon-file-pdf';
    return 'codicon-file';
  };

  /**
   * Get file extension
   */
  const getExtension = (fileName: string): string => {
    const parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
  };

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="attachment-list" role="list" aria-label="Attachments">
        {attachments.map((attachment) => {
          const imageAttachment = isImageAttachment(attachment);
          const extension = getExtension(attachment.fileName);
          const fallbackName = extension || attachment.fileName.slice(0, 6);

          return (
            <div
              key={attachment.id}
              className={`attachment-item ${imageAttachment ? 'attachment-item-image' : 'attachment-item-file'}`}
              onClick={() => handleClick(attachment)}
              title={attachment.fileName}
              role="listitem"
            >
              <span className="attachment-preview-frame">
                {imageAttachment ? (
                  <img
                    className="attachment-thumbnail"
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.fileName}
                  />
                ) : (
                  <span className={`attachment-file-icon codicon ${getFileIcon(attachment.mediaType)}`} />
                )}
              </span>

              <span className="attachment-label">
                {imageAttachment ? attachment.fileName : fallbackName}
              </span>

              <button
                className="attachment-remove"
                onClick={(e) => handleRemove(e, attachment.id)}
                title={t('chat.removeAttachment')}
                aria-label={t('chat.removeAttachment')}
              >
                <CopilotIcon name="x" size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Image preview dialog */}
      {previewImage && (
        <div
          className="image-preview-overlay"
          onClick={closePreview}
          onKeyDown={(e) => e.key === 'Escape' && closePreview()}
          tabIndex={0}
        >
          <img
            className="image-preview-content"
            src={`data:${previewImage.mediaType};base64,${previewImage.data}`}
            alt={previewImage.fileName}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="image-preview-close"
            onClick={closePreview}
            title={t('chat.closePreview')}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};

export default AttachmentList;
