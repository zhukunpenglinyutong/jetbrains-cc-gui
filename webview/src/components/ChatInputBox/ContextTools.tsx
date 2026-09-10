import React, { useRef, useCallback, memo } from 'react';
import { TokenIndicator } from './TokenIndicator';

const HIDDEN_INPUT_STYLE: React.CSSProperties = { display: 'none' };

interface ContextToolsProps {
  percentage: number;
  usedTokens?: number;
  maxTokens?: number;
  showUsage: boolean;
  onAddAttachment?: (files: FileList) => void;
}

/** Left tool icons group: attachment button, token indicator, hidden file input. */
export const ContextTools: React.FC<ContextToolsProps> = memo(({
  percentage,
  usedTokens,
  maxTokens,
  showUsage,
  onAddAttachment,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAttachClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddAttachment?.(e.target.files);
    }
    e.target.value = '';
  }, [onAddAttachment]);

  return (
    <div className="context-tools">
      <div
        className="context-tool-btn"
        onClick={handleAttachClick}
        title="Add attachment"
      >
        <span className="codicon codicon-attach" />
      </div>

      {/* Token Indicator */}
      {showUsage && (
        <div className="context-token-indicator">
          <TokenIndicator
            percentage={percentage}
            usedTokens={usedTokens}
            maxTokens={maxTokens}
            size={14}
          />
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden-file-input"
        onChange={handleFileChange}
        style={HIDDEN_INPUT_STYLE}
      />

      <div className="context-tool-divider" />
    </div>
  );
});
