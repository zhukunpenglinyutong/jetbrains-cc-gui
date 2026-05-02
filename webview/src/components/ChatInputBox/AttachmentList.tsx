import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Attachment, AttachmentListProps } from './types';
import { isImageAttachment } from './types';
import { ContextMenu } from '../ContextMenu';
import { copyImageSelection, useContextMenu } from '../../hooks/useContextMenu.js';
import { ImagePreviewOverlay } from '../ImagePreviewOverlay';

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
  const previewCtxMenu = useContextMenu();

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
    previewCtxMenu.close();
    setPreviewImage(null);
  }, [previewCtxMenu]);

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
      <div className="attachment-list">
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className="attachment-item"
            onClick={() => handleClick(attachment)}
            title={attachment.fileName}
          >
            {isImageAttachment(attachment) ? (
              <img
                className="attachment-thumbnail"
                src={`data:${attachment.mediaType};base64,${attachment.data}`}
                alt={attachment.fileName}
              />
            ) : (
              <div className="attachment-file">
                <span className={`attachment-file-icon codicon ${getFileIcon(attachment.mediaType)}`} />
                <span className="attachment-file-name">
                  {getExtension(attachment.fileName) || attachment.fileName.slice(0, 6)}
                </span>
              </div>
            )}

            <button
              className="attachment-remove"
              onClick={(e) => handleRemove(e, attachment.id)}
              title={t('chat.removeAttachment')}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Image preview dialog */}
      {previewImage && (
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
              src={`data:${previewImage.mediaType};base64,${previewImage.data}`}
              alt={previewImage.fileName}
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
};

export default AttachmentList;
