import React, { useRef, useState, useEffect, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { getFileIcon } from '../../utils/fileIcons';
import { CURSOR_DEFAULT_STYLE } from './contextBarStyles';

const FILE_ICON_STYLE: React.CSSProperties = {
  marginRight: 4,
  display: 'inline-flex',
  alignItems: 'center',
  width: 16,
  height: 16,
};

// Extract filename from path
const getFileName = (path: string) => {
  return path.split(/[/\\]/).pop() || path;
};

const getFileIconSvg = (path: string) => {
  const fileName = getFileName(path);
  const extension = fileName.indexOf('.') !== -1 ? fileName.split('.').pop() : '';
  return getFileIcon(extension, fileName);
};

interface FileContextChipProps {
  activeFile?: string;
  selectedLines?: string;
  autoOpenFileEnabled: boolean;
  onClearFile?: () => void;
  onRequestEnableFileContext?: () => void;
}

/**
 * Active Context Chip, or the empty placeholder (with enable-confirmation
 * popover) shown when file context auto-open is disabled.
 */
export const FileContextChip: React.FC<FileContextChipProps> = memo(({
  activeFile,
  selectedLines,
  autoOpenFileEnabled,
  onClearFile,
  onRequestEnableFileContext,
}) => {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [showEnablePopover, setShowEnablePopover] = useState(false);

  // Reset popover state when autoOpenFileEnabled changes
  useEffect(() => {
    if (autoOpenFileEnabled) {
      setShowEnablePopover(false);
    }
  }, [autoOpenFileEnabled]);

  // Click outside or Escape to close popover
  useEffect(() => {
    if (!showEnablePopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowEnablePopover(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowEnablePopover(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showEnablePopover]);

  const handlePlaceholderClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowEnablePopover(true);
  }, []);

  const handlePopoverCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowEnablePopover(false);
  }, []);

  const handlePopoverConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowEnablePopover(false);
    onRequestEnableFileContext?.();
  }, [onRequestEnableFileContext]);

  const displayText = activeFile ? (
    selectedLines ? `${getFileName(activeFile)}#${selectedLines}` : getFileName(activeFile)
  ) : '';

  const fullDisplayText = activeFile ? (
    selectedLines ? `${activeFile}#${selectedLines}` : activeFile
  ) : '';

  if (displayText) {
    return (
      <div
        className="context-item has-tooltip"
        data-tooltip={fullDisplayText}
        style={CURSOR_DEFAULT_STYLE}
      >
        {activeFile && (
          <span
            className="context-file-icon"
            style={FILE_ICON_STYLE}
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
    );
  }

  if (autoOpenFileEnabled) {
    return null;
  }

  return (
    <div className="context-file-placeholder-wrapper" ref={popoverRef}>
      <button
        className="context-file-placeholder"
        onClick={handlePlaceholderClick}
        title={t('fileContext.placeholder')}
        type="button"
      >
        <span className="codicon codicon-file" />
        <span className="placeholder-text">{t('fileContext.placeholder')}</span>
      </button>

      {showEnablePopover && (
        <div className="file-context-confirm-popover">
          <div className="popover-title">{t('fileContext.enableTitle')}</div>
          <div className="popover-description">{t('fileContext.enableDescription')}</div>
          <div className="popover-actions">
            <button
              className="popover-btn popover-btn-cancel"
              onClick={handlePopoverCancel}
            >
              {t('fileContext.cancel')}
            </button>
            <button
              className="popover-btn popover-btn-confirm"
              onClick={handlePopoverConfirm}
            >
              {t('fileContext.enable')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
