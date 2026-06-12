import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Attachment, AttachmentListProps } from './types';
import { isImageAttachment } from './types';
import { CoDriverIcon } from '../codriverIcons';
import { getFileIconKind } from '../../utils/fileIconKind';

const ATTACHMENT_PREVIEW_BUTTON_STYLE: React.CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
  display: 'inline-flex',
};

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

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="attachment-list" role="list" aria-label={t('chat.attachments', { defaultValue: 'Attachments' })}>
        {attachments.map((attachment) => {
          const imageAttachment = isImageAttachment(attachment);
          const fallbackName = attachment.fileName;
          const iconName = getFileIconKind(attachment.fileName);

          return (
            <div
              key={attachment.id}
              className={`attachment-item ${imageAttachment ? 'attachment-item-image' : 'attachment-item-file'}`}
              title={attachment.fileName}
              role="listitem"
            >
              {imageAttachment ? (
                <button
                  type="button"
                  className="attachment-preview-frame attachment-preview-button"
                  style={ATTACHMENT_PREVIEW_BUTTON_STYLE}
                  onClick={() => handleClick(attachment)}
                  aria-label={t('chat.previewImage', { defaultValue: 'Preview image' })}
                >
                  <img
                    className="attachment-thumbnail"
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.fileName}
                  />
                </button>
              ) : (
                <span className="attachment-preview-frame">
                  <CoDriverIcon
                    className={`attachment-file-icon attachment-file-icon-${iconName}`}
                    name={iconName}
                    size={17}
                    aria-hidden="true"
                  />
                </span>
              )}

              <span className="attachment-label">
                {imageAttachment ? attachment.fileName : fallbackName}
              </span>

              <button
                type="button"
                className="attachment-remove"
                onClick={(e) => handleRemove(e, attachment.id)}
                title={t('chat.removeAttachment')}
                aria-label={t('chat.removeAttachment')}
              >
                <CoDriverIcon name="x" size={12} />
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
            type="button"
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
