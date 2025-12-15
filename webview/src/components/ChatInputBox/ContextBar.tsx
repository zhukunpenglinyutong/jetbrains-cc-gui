import React, { useRef, useCallback } from 'react';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';
import type { FileItem } from './types';
import { TokenIndicator } from './TokenIndicator';

interface ContextBarProps {
  activeFile?: string;
  referencedFiles?: FileItem[];
  selectedLines?: string;
  percentage?: number;
  usedTokens?: number;
  maxTokens?: number;
  showUsage?: boolean;
  onClearFile?: () => void;
  onAddAttachment?: (files: FileList) => void;
  onInsertMention?: () => void;
  onRemoveReferencedFile?: (file: FileItem) => void;
}

export const ContextBar: React.FC<ContextBarProps> = ({
  activeFile,
  referencedFiles = [],
  selectedLines,
  percentage = 0,
  usedTokens,
  maxTokens,
  showUsage = true,
  onClearFile,
  onAddAttachment,
  onInsertMention,
  onRemoveReferencedFile
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
          onClick={onInsertMention}
          title="插入 @ 文件引用"
        >
          <span className="codicon codicon-mention" />
        </div>
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
          accept="image/*,.pdf,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.hpp,.css,.html,.xml,.yaml,.yml"
        />

        <div className="context-tool-divider" />
      </div>

      {/* Active Context Chip */}
      {displayText && (
        <div className="context-item has-tooltip" data-tooltip={fullDisplayText}>
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

      {/* Referenced files on the right */}
      {referencedFiles.length > 0 &&
          referencedFiles.map((file) => {
            const iconSvg = file.type === 'directory'
            ? getFolderIcon(file.name, false)
            : getFileIcon(file.extension, file.name);
            return (
            <div
              key={file.path}
              className="context-item has-tooltip"
              data-tooltip={file.path}
            >
              <span
                  className="context-ref-icon"
                  style={{
                      marginRight: 4,
                      display: 'inline-flex',
                      alignItems: 'center',
                      width: 16,
                      height: 16
                  }}
                  dangerouslySetInnerHTML={{ __html: iconSvg }}
              />
              <span className="context-text">
                  <span dir="ltr">{file.name}</span>
              </span>
              <span
                  className="codicon codicon-close context-close"
                  onClick={() => onRemoveReferencedFile?.(file)}
                  title="移除文件引用"
              />
            </div>
          );
        })}
    </div>
  );
};
