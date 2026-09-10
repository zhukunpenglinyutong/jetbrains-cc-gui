import type { MouseEvent, RefObject } from 'react';
import { openBrowser, openClass, openFile } from '../../utils/bridge';

// Copy to clipboard implementation
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // Fallback method for environments where navigator.clipboard is not available
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      return successful;
    } catch (e) {
      console.error('Copy failed:', e);
      return false;
    }
  }
}

/**
 * Click handler for the rendered markdown container: copy-code buttons,
 * image preview, and link routing (file/class/url) through the bridge.
 */
export function useMarkdownClickHandler(
  containerRef: RefObject<HTMLDivElement | null>,
  onImagePreview: (src: string | null) => void,
) {
  const handleClick = async (event: MouseEvent<HTMLDivElement>) => {
    // React synthetic events may have a Text node as target when the user
    // clicks inside an <a> element. Walk up to the parent element so that
    // element.closest() can be used safely.
    const targetNode = event.target as unknown as Node;
    const target = targetNode.nodeType === Node.TEXT_NODE
      ? (targetNode as Text).parentElement
      : (event.target as HTMLElement);

    const copyBtn = target?.closest('button.copy-code-btn') as HTMLButtonElement | null;
    if (copyBtn && containerRef.current?.contains(copyBtn)) {
      event.preventDefault();
      event.stopPropagation();

      const wrapper = copyBtn.closest('.code-block-wrapper');
      const codeElement = wrapper?.querySelector('pre code') as HTMLElement | null;
      const text = codeElement?.innerText || codeElement?.textContent || '';
      const success = await copyToClipboard(text);

      if (success) {
        copyBtn.classList.add('copied');
        window.setTimeout(() => copyBtn.classList.remove('copied'), 1500);
      }
      return;
    }

    const img = target?.closest('img');
    if (img && img.getAttribute('src')) {
      onImagePreview(img.getAttribute('src'));
      return;
    }

    let anchor = target?.closest('a');

    // Fallback: if the click target is not inside an <a> (e.g. a portal
    // tooltip with broken pointer-events overlaying the link), use the
    // click coordinates to find which <a> was actually clicked.
    if (!anchor && containerRef.current) {
      const x = event.clientX;
      const y = event.clientY;
      const links = containerRef.current.querySelectorAll('a');
      for (const link of Array.from(links)) {
        const rect = link.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          anchor = link as HTMLAnchorElement;
          break;
        }
      }
    }

    if (!anchor) {
      return;
    }

    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (!href) {
      return;
    }

    const linkType = anchor.getAttribute('data-linkify');

    if (linkType === 'file') {
      openFile(href);
      return;
    }

    if (linkType === 'class') {
      openClass(href);
      return;
    }

    if (linkType === 'url' || /^(https?:|mailto:)/.test(href)) {
      openBrowser(href);
    } else {
      openFile(href);
    }
  };

  return handleClick;
}
