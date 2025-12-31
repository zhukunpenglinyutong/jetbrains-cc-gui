import React, { useState, useRef, useEffect } from 'react';

interface CollapsibleTextBlockProps {
  content: string;
}

const MAX_HEIGHT = 160; // Approx 7-8 lines

const CollapsibleTextBlock: React.FC<CollapsibleTextBlockProps> = ({ content }) => {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contentRef.current) return;

    const checkHeight = () => {
      if (contentRef.current) {
        setIsOverflowing(contentRef.current.scrollHeight > MAX_HEIGHT);
      }
    };

    // Check initially
    checkHeight();

    // Use ResizeObserver to detect size changes (e.g. window resize or content loading)
    const observer = new ResizeObserver(checkHeight);
    observer.observe(contentRef.current);

    return () => observer.disconnect();
  }, [content]);

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(!expanded);
  };

  return (
    <div className={`collapsible-block ${expanded ? 'expanded' : 'collapsed'}`}>
      <div
        className="collapsible-content"
        ref={contentRef}
        style={{
            maxHeight: (expanded || !isOverflowing) ? 'none' : `${MAX_HEIGHT}px`,
            overflow: 'hidden'
        }}
      >
        <div className="plain-text-content">{content}</div>

        {/* Gradient overlay when collapsed */}
        {!expanded && isOverflowing && (
             <div className="collapse-overlay"></div>
        )}
      </div>

      {isOverflowing && (
        <div className="collapse-toggle" onClick={toggleExpand}>
            <span className="codicon codicon-chevron-down" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}></span>
        </div>
      )}
    </div>
  );
};

export default CollapsibleTextBlock;
