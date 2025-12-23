import React, { useRef, useCallback } from 'react';
import { getFileIcon } from '../../utils/fileIcons';
import { TokenIndicator } from './TokenIndicator';

interface ContextBarProps {
  activeFile?: string;
  selectedLines?: string;
  percentage?: number;
  usedTokens?: number;
  maxTokens?: number;
  showUsage?: boolean;
  onClearFile?: () => void;
  onAddAttachment?: (files: FileList) => void;
}

export const ContextBar: React.FC<ContextBarProps> = ({ 
  activeFile, 
  selectedLines,
  percentage = 0,
  usedTokens,
  maxTokens,
  showUsage = true,
  onClearFile,
  onAddAttachment
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

  // Extract filename from path
  const getFileName = (path: string) => {
    return path.split(/[/\\]/).pop() || path;
  };

  const getFileIconSvg = (path: string) => {
    const fileName = getFileName(path);
    const extension = fileName.indexOf('.') !== -1 ? fileName.split('.').pop() : '';
    return getFileIcon(extension, fileName);
  };

  const displayText = activeFile ? (
    selectedLines ? `${getFileName(activeFile)}#${selectedLines}` : getFileName(activeFile)
  ) : '';

  const fullDisplayText = activeFile ? (
    selectedLines ? `${activeFile}#${selectedLines}` : activeFile
  ) : '';

  return (
    <div className="context-bar">
      {/* Tool Icons Group */}
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
          style={{ display: 'none' }}
        />
        
        <div className="context-tool-divider" />
      </div>

      {/* Active Context Chip */}
      {displayText && (
        <div 
          className="context-item has-tooltip" 
          data-tooltip={fullDisplayText}
          style={{ cursor: 'default' }}
        >
          {activeFile && (
            <span 
              className="context-file-icon" 
              style={{ 
                marginRight: 4, 
                display: 'inline-flex', 
                alignItems: 'center',
                width: 16,
                height: 16
              }}
              dangerouslySetInnerHTML={{ __html: getFileIconSvg(activeFile) }}
            />
          )}
          <span className="context-text">
            <span dir="ltr">{displayText}</span>
          </span>
          <span 
            className="codicon codicon-close context-close" 
            onClick={onClearFile}
            title="Remove file context"
          />
        </div>
      )}
    </div>
  );
};
