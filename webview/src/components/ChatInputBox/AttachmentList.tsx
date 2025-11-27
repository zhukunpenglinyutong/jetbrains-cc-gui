import { useCallback, useState } from 'react';
import type { Attachment, AttachmentListProps } from './types';
import { isImageAttachment } from './types';

/**
 * AttachmentList - 附件列表组件
 * 显示图片缩略图或文件图标
 */
export const AttachmentList = ({
  attachments,
  onRemove,
  onPreview,
}: AttachmentListProps) => {
  const [previewImage, setPreviewImage] = useState<Attachment | null>(null);

  /**
   * 处理附件点击
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
   * 处理移除附件
   */
  const handleRemove = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onRemove?.(id);
  }, [onRemove]);

  /**
   * 关闭预览
   */
  const closePreview = useCallback(() => {
    setPreviewImage(null);
  }, []);

  /**
   * 获取文件图标
   */
  const getFileIcon = (mediaType: string): string => {
    if (mediaType.startsWith('text/')) return 'codicon-file-text';
    if (mediaType.includes('json')) return 'codicon-json';
    if (mediaType.includes('javascript') || mediaType.includes('typescript')) return 'codicon-file-code';
    if (mediaType.includes('pdf')) return 'codicon-file-pdf';
    return 'codicon-file';
  };

  /**
   * 获取文件扩展名
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
              title="移除附件"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* 图片预览对话框 */}
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
            title="关闭预览"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};

export default AttachmentList;
