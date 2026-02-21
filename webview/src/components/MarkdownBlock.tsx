import { marked } from 'marked';
import { memo, useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { openBrowser, openFile } from '../utils/bridge';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { markedHighlight } from 'marked-highlight';
// Lazy-loaded mermaid singleton (deferred until first diagram is encountered)
let mermaidInstance: typeof import('mermaid').default | null = null;
async function getMermaid() {
  if (!mermaidInstance) {
    const mod = await import('mermaid');
    mermaidInstance = mod.default;
    mermaidInstance.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
  }
  return mermaidInstance;
}

// Configure marked to use syntax highlighting
marked.use(
  markedHighlight({
    highlight(code: string, lang: string) {
      // Skip syntax highlighting for mermaid code blocks
      if (lang === 'mermaid') {
        return code;
      }
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {
          // Silently fall through to auto-highlight
        }
      }
      return hljs.highlightAuto(code).value;
    },
  })
);

// Mermaid syntax keywords used to detect diagram content (Set for O(1) lookup)
const MERMAID_KEYWORDS = new Set([
  'flowchart',
  'graph',
  'sequencediagram',
  'classdiagram',
  'statediagram',
  'statediagram-v2',
  'erdiagram',
  'journey',
  'gantt',
  'pie',
  'quadrantchart',
  'requirementdiagram',
  'gitgraph',
  'mindmap',
  'timeline',
  'zenuml',
  'sankey',
  'xychart',
  'xychart-beta',
  'block-beta',
]);

marked.setOptions({
  breaks: false,
  gfm: true,
});

interface MarkdownBlockProps {
  content?: string;
  isStreaming?: boolean;
}

/**
 * Stream-safe processing: handle unclosed code blocks and other markdown structures.
 * During streaming, code blocks may be truncated, causing markdown parsing errors.
 * This function detects and temporarily closes incomplete code blocks.
 */
function makeStreamSafe(content: string): string {
  if (!content) return content;

  let result = content;

  // Handle code blocks: detect unclosed fenced code blocks (```)
  // Track code block state using a state machine approach
  const lines = result.split('\n');
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    // Detect code block opening or closing
    if (trimmedLine.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
  }

  // If still inside a code block, append a closing fence
  if (inCodeBlock) {
    result = result + '\n```';
  }

  // Handle inline code: detect unclosed inline code (`)
  // Only process the last line to avoid affecting multiline structures
  const lastNewlineIndex = result.lastIndexOf('\n');
  const lastLine = lastNewlineIndex >= 0 ? result.slice(lastNewlineIndex + 1) : result;

  // Count single backticks in the last line (excluding double and triple backticks)
  const singleBacktickMatches = lastLine.match(/(?<!`)`(?!`)/g);
  if (singleBacktickMatches && singleBacktickMatches.length % 2 !== 0) {
    result = result + '`';
  }

  return result;
}

// Mermaid render counter for generating unique IDs
let mermaidIdCounter = 0;

// Copy icon SVG (hoisted to module scope to avoid recreation on each render)
const copyIconSvg = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4l0 8a2 2 0 0 0 2 2l8 0a2 2 0 0 0 2 -2l0 -8a2 2 0 0 0 -2 -2l-8 0a2 2 0 0 0 -2 2zm2 0l8 0l0 8l-8 0l0 -8z" fill="currentColor" fill-opacity="0.9"/>
      <path d="M2 2l0 8l-2 0l0 -8a2 2 0 0 1 2 -2l8 0l0 2l-8 0z" fill="currentColor" fill-opacity="0.6"/>
    </svg>
  `;

const MarkdownBlock = ({ content = '', isStreaming = false }: MarkdownBlockProps) => {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { t, i18n } = useTranslation();

  // Track previous isStreaming state to detect when streaming ends
  const prevIsStreamingRef = useRef(isStreaming);

  // Ref for tracking retry count
  const mermaidRetryRef = useRef(0);
  const MERMAID_MAX_RETRIES = 3;

  // Render mermaid diagrams
  const renderMermaidDiagrams = useCallback(async () => {
    if (!containerRef.current) return;

    const codeBlocks = containerRef.current.querySelectorAll('pre code');

    // If no code blocks found, reset retry count
    if (codeBlocks.length === 0) {
      mermaidRetryRef.current = 0;
      return;
    }

    let renderedAny = false;

    for (const codeBlock of codeBlocks) {
      const pre = codeBlock.parentElement;
      if (!pre) continue;

      const wrapper = pre.parentElement;
      if (wrapper?.classList.contains('mermaid-rendered')) continue;

      // Get the text content of the code block
      let code = codeBlock.textContent || '';

      // Clean up any remaining markdown markers (e.g., ```mermaid)
      code = code.replace(/^```mermaid\s*/i, '').replace(/```\s*$/, '').trim();

      if (!code) continue;

      // Check if the content is mermaid syntax (starts with a keyword)
      const firstWord = code.split(/[\s\n]/)[0].toLowerCase();
      const isMermaid = MERMAID_KEYWORDS.has(firstWord);

      if (!isMermaid) continue;

      try {
        const mmd = await getMermaid();
        const id = `mermaid-${++mermaidIdCounter}`;
        const { svg } = await mmd.render(id, code);

        const mermaidContainer = document.createElement('div');
        mermaidContainer.className = 'mermaid-diagram';
        mermaidContainer.innerHTML = svg;

        if (wrapper?.classList.contains('code-block-wrapper')) {
          wrapper.classList.add('mermaid-rendered');
          pre.style.display = 'none';
          wrapper.insertBefore(mermaidContainer, pre);
        } else {
          const newWrapper = document.createElement('div');
          newWrapper.className = 'code-block-wrapper mermaid-rendered';
          newWrapper.appendChild(mermaidContainer);
          pre.parentNode?.replaceChild(newWrapper, pre);
        }
        renderedAny = true;
      } catch {
        // Mermaid render error - silently skip invalid diagrams
      }
    }

    // If any diagrams were rendered, reset retry count
    if (renderedAny) {
      mermaidRetryRef.current = 0;
    }

    return renderedAny;
  }, []);

  // Render mermaid diagrams after HTML updates (skip during streaming to prevent flicker)
  useEffect(() => {
    if (isStreaming) return;

    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let retryRafId: number | null = null;

    // Use double requestAnimationFrame to ensure the DOM is fully rendered
    let rafId1 = requestAnimationFrame(() => {
      rafId1 = requestAnimationFrame(() => {
        renderMermaidDiagrams().then((rendered) => {
          // If no diagrams were rendered and retry limit not reached, retry after a delay
          if (!rendered && mermaidRetryRef.current < MERMAID_MAX_RETRIES) {
            mermaidRetryRef.current++;
            retryTimeoutId = setTimeout(() => {
              retryRafId = requestAnimationFrame(() => {
                renderMermaidDiagrams();
              });
            }, 100 * mermaidRetryRef.current);
          }
        });
      });
    });

    return () => {
      cancelAnimationFrame(rafId1);
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
      if (retryRafId) cancelAnimationFrame(retryRafId);
    };
  }, [content, isStreaming, renderMermaidDiagrams]);

  // Copy to clipboard implementation
  const copyToClipboard = async (text: string) => {
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
  };

  const html = useMemo(() => {
    try {
      // Strip trailing newlines to avoid extra whitespace
      let trimmedContent = content.replace(/[\r\n]+$/, '');

      // During streaming, handle unclosed code blocks
      if (isStreaming) {
        trimmedContent = makeStreamSafe(trimmedContent);
      }

      // The HTML returned by marked.parse may have trailing newlines that need to be trimmed
      const parsed = marked.parse(trimmedContent);
      const rawHtml = typeof parsed === 'string' ? parsed.trim() : String(parsed);

      if (typeof window === 'undefined' || !rawHtml) {
        return rawHtml;
      }

      const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
      const pres = doc.querySelectorAll('pre');
      const copySuccessText = t('markdown.copySuccess');
      const copyCodeTitle = t('markdown.copyCode');

      pres.forEach((pre) => {
        const parent = pre.parentElement;
        if (parent && parent.classList.contains('code-block-wrapper')) {
          return;
        }

        const wrapper = doc.createElement('div');
        wrapper.className = 'code-block-wrapper';

        pre.parentNode?.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-code-btn';
        btn.title = copyCodeTitle;
        btn.setAttribute('aria-label', copyCodeTitle);

        const iconSpan = doc.createElement('span');
        iconSpan.className = 'copy-icon';
        iconSpan.innerHTML = copyIconSvg;

        const tooltipSpan = doc.createElement('span');
        tooltipSpan.className = 'copy-tooltip';
        tooltipSpan.textContent = copySuccessText;

        btn.appendChild(iconSpan);
        btn.appendChild(tooltipSpan);

        wrapper.appendChild(btn);
      });

      return doc.body.innerHTML.trim();
    } catch {
      return content;
    }
  }, [content, isStreaming, i18n.language, t]);

  // Force DOM refresh when streaming ends to fix potential layout corruption from streaming render
  useEffect(() => {
    if (prevIsStreamingRef.current && !isStreaming && containerRef.current) {
      let rafId2: number | null = null;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      let done = false;

      const applyRefresh = () => {
        if (done || !containerRef.current) return;
        done = true;
        containerRef.current.innerHTML = html;
        renderMermaidDiagrams();
      };

      // Use double requestAnimationFrame to ensure DOM is fully updated
      const rafId1 = requestAnimationFrame(() => {
        rafId2 = requestAnimationFrame(() => {
          applyRefresh();
        });
        // Fallback: use setTimeout in case rAF doesn't fire in some environments
        fallbackTimer = setTimeout(() => {
          applyRefresh();
        }, 100);
      });

      prevIsStreamingRef.current = isStreaming;
      return () => {
        cancelAnimationFrame(rafId1);
        if (rafId2) cancelAnimationFrame(rafId2);
        if (fallbackTimer) clearTimeout(fallbackTimer);
      };
    }
    prevIsStreamingRef.current = isStreaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, html, renderMermaidDiagrams]);

  const handleClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;

    const copyBtn = target.closest('button.copy-code-btn') as HTMLButtonElement | null;
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

    const img = target.closest('img');
    if (img && img.getAttribute('src')) {
      setPreviewSrc(img.getAttribute('src'));
      return;
    }

    const anchor = target.closest('a');
    if (!anchor) {
      return;
    }

    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (!href) {
      return;
    }

    if (/^(https?:|mailto:)/.test(href)) {
      openBrowser(href);
    } else {
      openFile(href);
    }
  };

  return (
    <>
      <div
        ref={containerRef}
        className="markdown-content"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleClick}
      />
      {previewSrc && (
        <div
          className="image-preview-overlay"
          onClick={() => setPreviewSrc(null)}
          onKeyDown={(e) => e.key === 'Escape' && setPreviewSrc(null)}
          tabIndex={0}
        >
          <img
            className="image-preview-content"
            src={previewSrc}
            alt=""
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="image-preview-close"
            onClick={() => setPreviewSrc(null)}
            title={t('chat.closePreview')}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};

export default memo(MarkdownBlock);
