import { marked } from 'marked';
import { useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { openBrowser, openFile } from '../utils/bridge';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { markedHighlight } from 'marked-highlight';

// 配置 marked 使用语法高亮
marked.use(
  markedHighlight({
    highlight(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch (err) {
          console.error('[MarkdownBlock] Highlight error:', err);
        }
      }
      return hljs.highlightAuto(code).value;
    },
  })
);

marked.setOptions({
  breaks: false,
  gfm: true,
});

interface MarkdownBlockProps {
  content?: string;
}

const MarkdownBlock = ({ content = '' }: MarkdownBlockProps) => {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { t, i18n } = useTranslation();

  // 复制图标 SVG
  const copyIconSvg = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4l0 8a2 2 0 0 0 2 2l8 0a2 2 0 0 0 2 -2l0 -8a2 2 0 0 0 -2 -2l-8 0a2 2 0 0 0 -2 2zm2 0l8 0l0 8l-8 0l0 -8z" fill="currentColor" fill-opacity="0.9"/>
      <path d="M2 2l0 8l-2 0l0 -8a2 2 0 0 1 2 -2l8 0l0 2l-8 0z" fill="currentColor" fill-opacity="0.6"/>
    </svg>
  `;

  // 复制功能实现
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
      // 去除内容末尾的换行符，避免产生额外空白
      const trimmedContent = content.replace(/[\r\n]+$/, '');
      // marked.parse 返回的 HTML 末尾可能有换行符，也需要去除
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
    } catch (error) {
      console.error('[MarkdownBlock] Failed to parse markdown', error);
      return content;
    }
  }, [content, i18n.language, t]);

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
            title="关闭预览"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};

export default MarkdownBlock;
