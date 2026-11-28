import { useEffect } from 'react';
import { forceWebviewRepaint, repaintRemoteWebview } from '../utils/forceWebviewRepaint';

const SECOND_REPAINT_DELAY_MS = 500;

function repaintClosedOverlay(): void {
  forceWebviewRepaint('overlay-close');
  repaintRemoteWebview();
}

/**
 * Forces a full repaint when a panel-covering pop-up closes. Off-screen JCEF can keep showing the
 * pop-up although it is gone from the page, until something such as a resize repaints the panel.
 * The second repaint covers a first one that is lost while the host is still handling the action.
 */
export function useRepaintOnOverlayClose(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return;
    return () => {
      repaintClosedOverlay();
      window.setTimeout(repaintClosedOverlay, SECOND_REPAINT_DELAY_MS);
    };
  }, [isOpen]);
}
