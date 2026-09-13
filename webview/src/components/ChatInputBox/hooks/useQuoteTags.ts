import { useCallback, useEffect } from 'react';
import {
  createQuoteChipElement,
  getQuote,
  hasQuoteToken,
  pruneQuoteRegistry,
  quoteTokenRegex,
  removeQuote,
} from '../utils/quoteRegistry.js';
import {
  getVirtualCursorPosition,
  setVirtualCursorPosition,
} from '../utils/virtualCursorUtils.js';

interface UseQuoteTagsOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
}

interface UseQuoteTagsReturn {
  /** Convert any quote tokens in the input's text nodes into inline chip elements. */
  renderQuoteTags: () => void;
}

/**
 * useQuoteTags - Render inline quote chips from quote tokens in the input.
 *
 * Mirrors the file-tag mechanism: getTextContent() serializes a `.quote-tag`
 * chip back to its compact token, and this pass rebuilds the chip from the
 * token. The full Markdown blockquote is expanded from the registry only at
 * send time.
 */
export function useQuoteTags({ editableRef }: UseQuoteTagsOptions): UseQuoteTagsReturn {
  // Event delegation for closing quote chips (avoids per-chip listeners).
  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const closeElement = target?.closest?.('.quote-tag-close') as HTMLElement | null;
      if (!closeElement) return;

      event.preventDefault();
      event.stopPropagation();

      const tag = closeElement.closest('.quote-tag') as HTMLElement | null;
      if (!tag) return;
      const quoteId = tag.getAttribute('data-quote-id');
      if (quoteId) removeQuote(quoteId);
      tag.remove();
      // Let the input's own handler resync height/hasContent/completions.
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [editableRef]);

  const renderQuoteTags = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;

    // Collect every quote id still present — raw tokens in text nodes and
    // already-rendered chips — then drop registry entries that are gone
    // (chip deleted, input cleared, message sent) so the map cannot leak.
    const activeIds = new Set<string>();
    const tokenTextNodes: Text[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const content = node.textContent || '';
        if (hasQuoteToken(content)) {
          tokenTextNodes.push(node as Text);
          const scan = quoteTokenRegex();
          let m: RegExpExecArray | null;
          while ((m = scan.exec(content)) !== null) {
            activeIds.add(m[1]);
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        if (element.classList.contains('quote-tag')) {
          const id = element.getAttribute('data-quote-id');
          if (id) activeIds.add(id);
          return;
        }
        if (!element.classList.contains('file-tag')) {
          node.childNodes.forEach(walk);
        }
      }
    };
    el.childNodes.forEach(walk);
    pruneQuoteRegistry(activeIds);
    if (tokenTextNodes.length === 0) return;

    // Chip virtual length equals token length, so the saved offset stays valid.
    const savedOffset = getVirtualCursorPosition(el);

    for (const textNode of tokenTextNodes) {
      const text = textNode.textContent || '';
      const regex = quoteTokenRegex();
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let replaced = false;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        const quoteId = match[1];
        const entry = getQuote(quoteId);
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        if (entry) {
          fragment.appendChild(createQuoteChipElement(quoteId, entry));
        }
        lastIndex = match.index + match[0].length;
        replaced = true;
      }

      if (!replaced) continue;
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.parentNode?.replaceChild(fragment, textNode);
    }

    setVirtualCursorPosition(el, savedOffset);
  }, [editableRef]);

  return { renderQuoteTags };
}
