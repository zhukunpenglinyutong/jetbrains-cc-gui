import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCountdown } from '../utils/helpers';
import './PlanApprovalDialog.css';

// 超时配置（与后端 PermissionHandler.java 保持一致）
const TIMEOUT_SECONDS = 300; // 5 分钟
const WARNING_THRESHOLD_SECONDS = 30; // 剩余 30 秒时显示警告

export interface AllowedPrompt {
  tool: string;
  prompt: string;
}

export interface PlanApprovalRequest {
  requestId: string;
  toolName: string;
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
  // 控制弹窗是否收起（紧凑模式）
  const [isCollapsed, setIsCollapsed] = useState(false);
  // 倒计时剩余秒数
  const [remainingSeconds, setRemainingSeconds] = useState(TIMEOUT_SECONDS);
  // 是否显示超时警告
  const isTimeWarning = remainingSeconds <= WARNING_THRESHOLD_SECONDS && remainingSeconds > 0;
  // 是否已超时
  const isTimedOut = remainingSeconds <= 0;

  // 定时器引用
  const timerRef = useRef<number | null>(null);

  const handleApprove = useCallback(() => {
    if (!request) return;
    onApprove(request.requestId, selectedMode);
  }, [request, selectedMode, onApprove]);

  const handleReject = useCallback(() => {
    if (!request) return;
    onReject(request.requestId);
  }, [request, onReject]);

  // 重置状态
  useEffect(() => {
    if (isOpen && request) {
      // Reset to default mode when dialog opens
      setSelectedMode('default');
      setIsCollapsed(false);
      // 重置倒计时
      setRemainingSeconds(TIMEOUT_SECONDS);
    }
  }, [isOpen, request?.requestId]);

  // 键盘事件处理
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

  // 倒计时定时器
  useEffect(() => {
    // 清除定时器的辅助函数
    const clearTimer = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    // 如果对话框未打开或没有请求，清理并退出
    if (!isOpen || !request) {
      clearTimer();
      return;
    }

    // 清除之前的定时器（防止重复）
    clearTimer();

    // 启动倒计时
    timerRef.current = window.setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          // 超时，清除定时器
          clearTimer();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // cleanup 函数
    return clearTimer;
  }, [isOpen, request?.requestId]);

  // 超时自动关闭
  useEffect(() => {
    if (isTimedOut && request) {
      // 超时自动拒绝
      handleReject();
    }
  }, [isTimedOut, request, handleReject]);

  if (!isOpen || !request) {
    return null;
  }

  const handleModeChange = (modeId: string) => {
    setSelectedMode(modeId);
  };

  // 收起模式的渲染
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
      <div className="plan-approval-dialog">
        {/* 超时警告提示 */}
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
            {/* 倒计时显示 */}
            <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
              <span className="codicon codicon-clock" />
              <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
            </span>
            {/* 收起按钮 */}
            <button
              className="collapse-button"
              onClick={() => setIsCollapsed(true)}
              title={t('common.collapse', '收起')}
            >
              <span className="codicon codicon-chevron-down" />
            </button>
          </div>
        </div>

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
