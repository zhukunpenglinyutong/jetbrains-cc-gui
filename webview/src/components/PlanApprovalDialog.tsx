import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './PlanApprovalDialog.css';

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

  useEffect(() => {
    if (isOpen && request) {
      // Reset to default mode when dialog opens
      setSelectedMode('default');

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
  }, [isOpen]);

  if (!isOpen || !request) {
    return null;
  }

  const handleApprove = () => {
    onApprove(request.requestId, selectedMode);
  };

  const handleReject = () => {
    onReject(request.requestId);
  };

  const handleModeChange = (modeId: string) => {
    setSelectedMode(modeId);
  };

  return (
    <div className="permission-dialog-overlay">
      <div className="plan-approval-dialog">
        {/* Title */}
        <h3 className="plan-approval-dialog-title">
          {t('planApproval.title', 'Plan Ready for Approval')}
        </h3>
        <p className="plan-approval-dialog-subtitle">
          {t('planApproval.subtitle', 'Claude has finished planning and is ready to execute.')}
        </p>

        {/* Allowed Prompts Section */}
        {/* {request.allowedPrompts && request.allowedPrompts.length > 0 && (
          <div className="plan-approval-prompts">
            <h4 className="prompts-header">
              {t('planApproval.requestedPermissions', 'Requested Permissions')}
            </h4>
            <div className="prompts-list">
              {request.allowedPrompts.map((prompt, index) => (
                <div key={index} className="prompt-item">
                  <span className="prompt-tool">{prompt.tool}</span>
                  <span className="prompt-text">{prompt.prompt}</span>
                </div>
              ))}
            </div>
          </div>
        )} */}

        {/* Execution Mode Selection */}
        <div className="plan-approval-mode-section">
          <h4 className="mode-header">
            {t('planApproval.executionMode', 'Execution Mode')}
          </h4>
          <p className="mode-description">
            {t('planApproval.executionModeDescription', 'Select how Claude should execute the plan:')}
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
            {t('planApproval.reject', 'Reject')}
          </button>

          <div className="action-buttons-right">
            <button
              className="action-button primary"
              onClick={handleApprove}
            >
              {t('planApproval.approve', 'Approve & Execute')}
            </button>
          </div>
        </div>

        {/* Keyboard hints */}
        <div className="plan-approval-hints">
          <span className="hint">
            <kbd>Enter</kbd> {t('planApproval.toApprove', 'to approve')}
          </span>
          <span className="hint">
            <kbd>Esc</kbd> {t('planApproval.toReject', 'to reject')}
          </span>
        </div>
      </div>
    </div>
  );
};

export default PlanApprovalDialog;
