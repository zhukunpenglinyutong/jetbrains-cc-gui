interface ImagePreviewOverlayProps {
  src: string;
  closeTitle: string;
  onClose: () => void;
}

/**
 * Full-screen image preview overlay shown when a markdown image is clicked.
 */
export function ImagePreviewOverlay({ src, closeTitle, onClose }: ImagePreviewOverlayProps) {
  return (
    <div
      className="image-preview-overlay"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      tabIndex={0}
    >
      <img
        className="image-preview-content"
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
      />
      <button
        className="image-preview-close"
        onClick={onClose}
        title={closeTitle}
      >
        ×
      </button>
    </div>
  );
}
