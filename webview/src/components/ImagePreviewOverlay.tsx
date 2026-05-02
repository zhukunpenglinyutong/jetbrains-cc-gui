import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

interface ImagePreviewOverlayProps {
  children: ReactNode;
}

/**
 * Render image preview overlays at document.body level so they always float above
 * chat/status panel content, independent of local stacking contexts.
 */
export function ImagePreviewOverlay({ children }: ImagePreviewOverlayProps) {
  if (typeof document === 'undefined') {
    return null;
  }
  return createPortal(children, document.body);
}

