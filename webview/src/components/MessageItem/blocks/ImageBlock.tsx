import type { TFunction } from 'i18next';
import type { ClaudeContentBlock } from '../../../types';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ImageBlockProps {
  block: Extract<ClaudeContentBlock, { type: 'image' }>;
  messageType: string;
  t: TFunction;
}

export function ImageBlock({ block, messageType, t }: ImageBlockProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!previewOpen) return;
    if (!block.src?.trim()) { setPreviewOpen(false); return; }
    close.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewOpen(false);
      if (event.key === 'Tab') { event.preventDefault(); close.current?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); button.current?.focus(); };
  }, [previewOpen, block.src]);

  if (!block.src?.trim()) return null;

  return (
    <>
    <button
      ref={button}
      type="button"
      className={`message-image-block ${messageType === 'user' ? 'user-image' : ''}`}
      onClick={() => setPreviewOpen(true)}
      aria-label={t('chat.clickToPreview')}
      title={t('chat.clickToPreview')}
    >
      <img
        src={block.src}
        alt={block.alt || t('chat.userUploadedImage')}
        loading="lazy"
      />
    </button>
    {previewOpen && createPortal(<div className="image-preview-overlay" role="dialog" aria-modal="true"
      aria-label={t('chat.imagePreview')} onClick={() => setPreviewOpen(false)}>
      <img src={block.src} alt={block.alt || t('chat.imagePreview')} className="image-preview-content" onClick={(event) => event.stopPropagation()} />
      <button ref={close} type="button" className="image-preview-close" aria-label={t('common.close')}
        onClick={() => setPreviewOpen(false)}>×</button>
    </div>, document.getElementById('image-preview-root') ?? document.body)}
    </>
  );
}
