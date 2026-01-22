import { marked } from 'marked';
import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { openBrowser, openFile } from '../utils/bridge';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { markedHighlight } from 'marked-highlight';
import mermaid from 'mermaid';

// 初始化 mermaid 配置
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  fontFamily: 'inherit',
});

// 配置 marked 使用语法高亮
marked.use(
  markedHighlight({
    highlight(code: string, lang: string) {
      // mermaid 代码块不做高亮处理
      if (lang === 'mermaid') {
        return code;
      }
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

// Mermaid 语法关键字，用于检测代码内容
const MERMAID_KEYWORDS = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'quadrantChart',
  'requirementDiagram',
  'gitGraph',
  'mindmap',
  'timeline',
  'zenuml',
  'sankey',
  'xychart',
  'block-beta',
];

marked.setOptions({
  breaks: false,
  gfm: true,
});

interface MarkdownBlockProps {
  content?: string;
  isStreaming?: boolean; // App.tsx 传递的属性，MarkdownBlock 不使用
}

// Mermaid 渲染计数器，用于生成唯一 ID
let mermaidIdCounter = 0;

const MarkdownBlock = ({ content = '' }: MarkdownBlockProps) => {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { t, i18n } = useTranslation();

  // 渲染 mermaid 图表
  const renderMermaidDiagrams = useCallback(async () => {
    if (!containerRef.current) return;

    const codeBlocks = containerRef.current.querySelectorAll('pre code');

    for (const codeBlock of codeBlocks) {
      const pre = codeBlock.parentElement;
      if (!pre) continue;

      const wrapper = pre.parentElement;
      if (wrapper?.classList.contains('mermaid-rendered')) continue;

      // 获取代码文本内容
      let code = codeBlock.textContent || '';

      // 清理可能残留的 markdown 标记（如 ```mermaid）
      code = code.replace(/^```mermaid\s*/i, '').replace(/```\s*$/, '').trim();

      if (!code) continue;

      // 检查是否是 mermaid 语法（以关键字开头）
      const firstWord = code.split(/[\s\n]/)[0].toLowerCase();
      const isMermaid = MERMAID_KEYWORDS.some(kw =>
        firstWord === kw.toLowerCase() || firstWord.startsWith(kw.toLowerCase())
      );

      if (!isMermaid) continue;

      try {
        const id = `mermaid-${++mermaidIdCounter}`;
        const { svg } = await mermaid.render(id, code);

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
      } catch (err) {
        console.error('[MarkdownBlock] Mermaid render error:', err);
      }
    }
  }, []);

  // 在 HTML 更新后渲染 mermaid 图表
  useEffect(() => {
    renderMermaidDiagrams();
  }, [content, renderMermaidDiagrams]);

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
            title={t('chat.closePreview')}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};

export default MarkdownBlock;
