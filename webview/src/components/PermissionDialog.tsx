import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownBlock from './MarkdownBlock';

export interface PermissionRequest {
  channelId: string;
  toolName: string;
  inputs: Record<string, any>;
  suggestions?: any;
}

interface PermissionDialogProps {
  isOpen: boolean;
  request: PermissionRequest | null;
  onApprove: (channelId: string) => void;
  onSkip: (channelId: string) => void;
  onApproveAlways: (channelId: string) => void;
}

const PermissionDialog = ({
  isOpen,
  request,
  onApprove,
  onSkip,
  onApproveAlways,
}: PermissionDialogProps) => {
  const [showCommand, setShowCommand] = useState(true); // Expand command by default
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { t } = useTranslation();

  // Resize state
  const [dialogHeight, setDialogHeight] = useState<number | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
    dragStartYRef.current = e.clientY;
    dragStartHeightRef.current = dialogRef.current?.offsetHeight ?? 0;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleResizeMove = (e: PointerEvent) => {
      if (!isDraggingRef.current) return;
      const delta = dragStartYRef.current - e.clientY;
      const newHeight = Math.max(150, Math.min(window.innerHeight * 0.9, dragStartHeightRef.current + delta));
      setDialogHeight(newHeight);
    };
    const handleResizeEnd = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', handleResizeMove);
    window.addEventListener('pointerup', handleResizeEnd);
    return () => {
      window.removeEventListener('pointermove', handleResizeMove);
      window.removeEventListener('pointerup', handleResizeEnd);
      // Ensure body styles are cleaned up if dialog closes mid-drag
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);

  const handleApprove = () => {
    if (!request) return;
    onApprove(request.channelId);
  };

  const handleApproveAlways = () => {
    if (!request) return;
    onApproveAlways(request.channelId);
  };

  const handleSkip = () => {
    if (!request) return;
    onSkip(request.channelId);
  };

  useEffect(() => {
    if (isOpen && request) {
      setShowCommand(true); // Expand by default each time it opens
      setSelectedIndex(0);
      setDialogHeight(null);

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === '1') {
          handleApprove();
        } else if (e.key === '2') {
          handleApproveAlways();
        } else if (e.key === '3') {
          handleSkip();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex(prev => Math.max(0, prev - 1));
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex(prev => Math.min(2, prev + 1));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          // Use current selectedIndex from closure instead of state
          setSelectedIndex(current => {
            if (current === 0) handleApprove();
            else if (current === 1) handleApproveAlways();
            else if (current === 2) handleSkip();
            return current;
          });
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, request, onApprove, onApproveAlways, onSkip]);

  if (!isOpen || !request) {
    return null;
  }

  // Format input parameters for display
  const formatInputValue = (value: any): string => {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  };

  // Get the command or primary action content
  const getCommandContent = (): string => {
    // Get primary content based on tool type
    if (request.inputs.command) {
      return request.inputs.command;
    }
    if (request.inputs.content) {
      return request.inputs.content;
    }
    if (request.inputs.text) {
      return request.inputs.text;
    }
    // For other tools, format all inputs
    return Object.entries(request.inputs)
      .map(([key, value]) => `${key}: ${formatInputValue(value)}`)
      .join('\n');
  };

  // Get working directory
  const getWorkingDirectory = (): string => {
    if (request.inputs.cwd) {
      return request.inputs.cwd;
    }
    if (request.inputs.file_path) {
      return request.inputs.file_path;
    }
    if (request.inputs.path) {
      return request.inputs.path;
    }
    return '~';
  };

  // Map tool name to display title
  const getToolTitle = (toolName: string): string => {
    const key = `permission.tools.${toolName}`;
    const translated = t(key);
    // If translation key does not exist, return default template
    if (translated === key) {
      return t('permission.tools.execute', { toolName });
    }
    return translated;
  };

  const commandContent = getCommandContent();
  const workingDirectory = getWorkingDirectory();

  return (
    <div className="permission-dialog-overlay">
      <div
        ref={dialogRef}
        className="permission-dialog-v3"
        style={dialogHeight ? { height: dialogHeight, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const } : undefined}
      >
        {/* Resize handle */}
        <div className="permission-dialog-v3-resize-handle" onPointerDown={handleResizeStart} />
        {/* Title area */}
        <h3 className="permission-dialog-v3-title">{getToolTitle(request.toolName)}</h3>
        <p className="permission-dialog-v3-subtitle">{t('permission.fromExternalProcess')}</p>

        {/* Command/content area */}
        <div className="permission-dialog-v3-command-box">
          <div className="permission-dialog-v3-command-header">
            <span className="command-path">
              <span className="command-arrow">→</span> ~ {workingDirectory}
            </span>
            <button
              className="command-toggle"
              onClick={() => setShowCommand(!showCommand)}
              title={showCommand ? t('chat.collapse') : t('chat.expand')}
            >
              <span className={`codicon codicon-chevron-${showCommand ? 'up' : 'down'}`} />
            </button>
          </div>

          {showCommand && (
            <div
              className="permission-dialog-v3-command-content"
              style={dialogHeight ? { maxHeight: 'none' } : undefined}
            >
              <MarkdownBlock content={commandContent} isStreaming={false} />
            </div>
          )}
        </div>

        {/* Option buttons list */}
        <div className="permission-dialog-v3-options">
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 0 ? 'selected' : ''}`}
            onClick={handleApprove}
            onMouseEnter={() => setSelectedIndex(0)}
          >
            <span className="option-text">{t('permission.allow')}</span>
            <span className="option-key">1</span>
          </button>
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 1 ? 'selected' : ''}`}
            onClick={handleApproveAlways}
            onMouseEnter={() => setSelectedIndex(1)}
          >
            <span className="option-text">{t('permission.allowAlways')}</span>
            <span className="option-key">2</span>
          </button>
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 2 ? 'selected' : ''}`}
            onClick={handleSkip}
            onMouseEnter={() => setSelectedIndex(2)}
          >
            <span className="option-text">{t('permission.deny')}</span>
            <span className="option-key">3</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default PermissionDialog;
