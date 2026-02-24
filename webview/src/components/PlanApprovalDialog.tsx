import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCountdown } from '../utils/helpers';
import MarkdownBlock from './MarkdownBlock';
import './PlanApprovalDialog.css';

// Timeout configuration (kept in sync with backend PermissionHandler.java)
const TIMEOUT_SECONDS = 300; // 5 minutes
const WARNING_THRESHOLD_SECONDS = 30; // Show warning when 30 seconds remain

export interface AllowedPrompt {
  tool: string;
  prompt: string;
}

export interface PlanApprovalRequest {
  requestId: string;
  toolName: string;
  plan?: string;
  allowedPrompts?: AllowedPrompt[];
  timestamp?: string;
}

interface PlanApprovalDialogProps {
  isOpen: boolean;
  request: PlanApprovalRequest | null;
  onApprove: (requestId: string, targetMode: string) => void;
  onReject: (requestId: string) => void;
}

// Execution modes available after plan approval
const EXECUTION_MODES = [
  { id: 'default', labelKey: 'modes.default.label', descriptionKey: 'modes.default.description' },
  { id: 'acceptEdits', labelKey: 'modes.acceptEdits.label', descriptionKey: 'modes.acceptEdits.description' },
  { id: 'bypassPermissions', labelKey: 'modes.bypassPermissions.label', descriptionKey: 'modes.bypassPermissions.description' },
];

const PlanApprovalDialog = ({
  isOpen,
  request,
  onApprove,
  onReject,
}: PlanApprovalDialogProps) => {
  const { t } = useTranslation();
  const [selectedMode, setSelectedMode] = useState('default');
  // Controls whether the dialog is collapsed (compact mode)
  const [isCollapsed, setIsCollapsed] = useState(false);
  // Remaining countdown seconds
  const [remainingSeconds, setRemainingSeconds] = useState(TIMEOUT_SECONDS);
  // Whether to show timeout warning
  const isTimeWarning = remainingSeconds <= WARNING_THRESHOLD_SECONDS && remainingSeconds > 0;
  // Whether the dialog has timed out
  const isTimedOut = remainingSeconds <= 0;

  // Timer reference
  const timerRef = useRef<number | null>(null);

  // Resize state: user can drag the top edge to make the dialog taller
  const [dialogHeight, setDialogHeight] = useState<number | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleApprove = useCallback(() => {
    if (!request) return;
    onApprove(request.requestId, selectedMode);
  }, [request, selectedMode, onApprove]);

  const handleReject = useCallback(() => {
    if (!request) return;
    onReject(request.requestId);
  }, [request, onReject]);

  // Resize handlers: drag the top edge to make the dialog taller/shorter
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
      const newHeight = Math.max(200, Math.min(window.innerHeight * 0.9, dragStartHeightRef.current + delta));
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

  // Reset state
  useEffect(() => {
    if (isOpen && request) {
      // Reset to default mode when dialog opens
      setSelectedMode('default');
      setIsCollapsed(false);
      // Reset countdown
      setRemainingSeconds(TIMEOUT_SECONDS);
      setDialogHeight(null);
    }
  }, [isOpen, request?.requestId]);

  // Keyboard event handling
  useEffect(() => {
    if (isOpen && request) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleReject();
        } else if (e.key === 'Enter') {
          handleApprove();
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, request, handleApprove, handleReject]);

  // Countdown timer
  useEffect(() => {
    // Helper function to clear the timer
    const clearTimer = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    // If dialog is not open or there is no request, clean up and exit
    if (!isOpen || !request) {
      clearTimer();
      return;
    }

    // Clear previous timer (prevent duplicates)
    clearTimer();

    // Start countdown
    timerRef.current = window.setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          // Timed out, clear timer
          clearTimer();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Cleanup function
    return clearTimer;
  }, [isOpen, request?.requestId]);

  // Auto-close on timeout
  useEffect(() => {
    if (isTimedOut && request) {
      // Auto-reject on timeout
      handleReject();
    }
  }, [isTimedOut, request, handleReject]);

  if (!isOpen || !request) {
    return null;
  }

  const handleModeChange = (modeId: string) => {
    setSelectedMode(modeId);
  };

  // Render collapsed mode
  if (isCollapsed) {
    return (
      <div className="permission-dialog-overlay collapsed-mode">
        <div className="plan-approval-dialog-collapsed">
          <div className="collapsed-header">
            <span className="collapsed-title">
              {t('planApproval.title', '计划已准备就绪')}
            </span>
            <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
              <span className="codicon codicon-clock" />
              <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
            </span>
          </div>
          <button
            className="expand-button"
            onClick={() => setIsCollapsed(false)}
            title={t('common.expand', '展开')}
          >
            <span className="codicon codicon-chevron-up" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`permission-dialog-overlay ${isTimeWarning ? 'warning-mode' : ''}`}>
      <div
        ref={dialogRef}
        className="plan-approval-dialog"
        style={dialogHeight ? { height: dialogHeight, maxHeight: '90vh' } : undefined}
      >
        {/* Resize handle at the top edge */}
        <div className="plan-approval-resize-handle" onPointerDown={handleResizeStart} />
        {/* Timeout warning notice */}
        {isTimeWarning && (
          <div className="timeout-warning-banner">
            <span className="codicon codicon-warning" />
            <span>{t('planApproval.timeoutWarning', '请尽快做出选择，对话框将在 {{seconds}} 秒后自动关闭', { seconds: remainingSeconds })}</span>
          </div>
        )}

        {/* Header with collapse button and countdown */}
        <div className="plan-approval-dialog-header">
          <div className="header-left">
            <h3 className="plan-approval-dialog-title">
              {t('planApproval.title', '计划已准备就绪')}
            </h3>
            <p className="plan-approval-dialog-subtitle">
              {t('planApproval.subtitle', 'Claude 已完成规划，准备执行。')}
            </p>
          </div>
          <div className="header-right">
            {/* Countdown display */}
            <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
              <span className="codicon codicon-clock" />
              <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
            </span>
            {/* Collapse button */}
            <button
              className="collapse-button"
              onClick={() => setIsCollapsed(true)}
              title={t('common.collapse', '收起')}
            >
              <span className="codicon codicon-chevron-down" />
            </button>
          </div>
        </div>

        {/* Plan content (markdown) */}
        {request.plan && (
          <div className="plan-approval-content">
            <MarkdownBlock content={request.plan} isStreaming={false} />
          </div>
        )}

        {/* Execution Mode Selection */}
        <div className="plan-approval-mode-section">
          <h4 className="mode-header">
            {t('planApproval.executionMode', '执行模式')}
          </h4>
          <p className="mode-description">
            {t('planApproval.executionModeDescription', '选择 Claude 执行计划的方式：')}
          </p>
          <div className="mode-options">
            {EXECUTION_MODES.map((mode) => (
              <button
                key={mode.id}
                className={`mode-option ${selectedMode === mode.id ? 'selected' : ''}`}
                onClick={() => handleModeChange(mode.id)}
              >
                <div className="mode-radio">
                  <span className={`codicon codicon-${selectedMode === mode.id ? 'circle-filled' : 'circle-outline'}`} />
                </div>
                <div className="mode-content">
                  <div className="mode-label">{t(mode.labelKey, mode.id)}</div>
                  <div className="mode-option-description">{t(mode.descriptionKey, '')}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="plan-approval-dialog-actions">
          <button
            className="action-button secondary"
            onClick={handleReject}
          >
            {t('planApproval.reject', '拒绝')}
          </button>

          <div className="action-buttons-right">
            <button
              className="action-button primary"
              onClick={handleApprove}
            >
              {t('planApproval.approve', '批准并执行')}
            </button>
          </div>
        </div>

        {/* Keyboard hints */}
        <div className="plan-approval-hints">
          <span className="hint">
            <kbd>Enter</kbd> {t('planApproval.toApprove', '批准')}
          </span>
          <span className="hint">
            <kbd>Esc</kbd> {t('planApproval.toReject', '拒绝')}
          </span>
        </div>
      </div>
    </div>
  );
};

export default PlanApprovalDialog;
