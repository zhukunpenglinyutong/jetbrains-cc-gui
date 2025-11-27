import { marked } from 'marked';
import { useMemo, useState } from 'react';
import { openBrowser, openFile } from '../utils/bridge';

marked.setOptions({
  breaks: false,
  gfm: true,
});

interface MarkdownBlockProps {
  content?: string;
}

const MarkdownBlock = ({ content = '' }: MarkdownBlockProps) => {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const html = useMemo(() => {
    try {
      return marked.parse(content);
    } catch (error) {
      console.error('[MarkdownBlock] Failed to parse markdown', error);
      return content;
    }
  }, [content]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
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
