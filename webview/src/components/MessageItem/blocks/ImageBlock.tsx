import type { TFunction } from 'i18next';
import type { ClaudeContentBlock } from '../../../types';

const IMAGE_BLOCK_STYLE: React.CSSProperties = { cursor: 'pointer' };

function getImageStyle(isUser: boolean): React.CSSProperties {
  return {
    maxWidth: isUser ? '200px' : '100%',
    maxHeight: isUser ? '150px' : 'auto',
    borderRadius: '8px',
    objectFit: 'contain',
  };
}

interface ImageBlockProps {
  block: Extract<ClaudeContentBlock, { type: 'image' }>;
  messageType: string;
  t: TFunction;
}

export function ImageBlock({ block, messageType, t }: ImageBlockProps) {
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
      style={IMAGE_BLOCK_STYLE}
      title={t('chat.clickToPreview')}
    >
      <img
        src={block.src}
        alt={t('chat.userUploadedImage')}
        style={getImageStyle(messageType === 'user')}
      />
    </div>
  );
}
