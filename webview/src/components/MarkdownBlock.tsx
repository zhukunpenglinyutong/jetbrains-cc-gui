import { marked } from 'marked';
import { useMemo } from 'react';
import { openBrowser, openFile } from '../utils/bridge';

marked.setOptions({
  breaks: false,
  gfm: true,
});

interface MarkdownBlockProps {
  content?: string;
}

const MarkdownBlock = ({ content = '' }: MarkdownBlockProps) => {
  const html = useMemo(() => {
    try {
      return marked.parse(content);
    } catch (error) {
      console.error('[MarkdownBlock] Failed to parse markdown', error);
      return content;
    }
  }, [content]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
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
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
};

export default MarkdownBlock;

