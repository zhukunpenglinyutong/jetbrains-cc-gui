import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

export interface RewindRequest {
  sessionId: string;
  userMessageId: string;
  messageContent: string;
  messageTimestamp?: string;
  messagesAfterCount: number;
}

interface RewindDialogProps {
  isOpen: boolean;
  request: RewindRequest | null;
  isLoading?: boolean;
  onConfirm: (sessionId: string, userMessageId: string) => void;
  onCancel: () => void;
}

const RewindDialog = ({
  isOpen,
  request,
  isLoading = false,
  onConfirm,
  onCancel,
}: RewindDialogProps) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onCancel();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onCancel]);

  if (!isOpen || !request) {
    return null;
  }

  const handleConfirm = () => {
    onConfirm(request.sessionId, request.userMessageId);
  };

  // Truncate message content for display
  const displayContent = request.messageContent.length > 50
    ? `${request.messageContent.substring(0, 50)}...`
    : request.messageContent;

  return (
    <div className="confirm-dialog-overlay" onClick={onCancel}>
      <div className="confirm-dialog rewind-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">
          <h3 className="confirm-dialog-title">
            <span className="rewind-icon">&#x21BA;</span> {t('rewind.title', 'Rewind Files to Previous State')}
          </h3>
        </div>
        <div className="confirm-dialog-body">
          {isLoading ? (
            <div className="rewind-loading">
              <span className="codicon codicon-loading codicon-modifier-spin rewind-loading-icon" />
              <span className="rewind-loading-text">{t('rewind.restoring', 'Restoring files...')}</span>
            </div>
          ) : (
            <>
              <div className="rewind-target">
                <div className="rewind-target-label">{t('rewind.rewindTo', 'Rewind to')}:</div>
                <div className="rewind-target-message">
                  {request.messageTimestamp && (
                    <span className="rewind-timestamp">[{request.messageTimestamp}]</span>
                  )}
                  <span className="rewind-content">"{displayContent}"</span>
                </div>
              </div>

              <div className="rewind-warning">
                <div className="rewind-warning-icon">&#x26A0;</div>
                <div className="rewind-warning-content">
                  <div className="rewind-warning-title">{t('rewind.impact', 'Impact')}:</div>
                  <ul className="rewind-warning-list">
                    <li>{t('rewind.willRestore', 'Will restore files to their state at this message')}</li>
                    <li>
                      {t('rewind.changesLost', 'Changes made after this point will be lost')}
                      {request.messagesAfterCount > 0 && (
                        <span className="rewind-affected-count">
                          ({request.messagesAfterCount} {t('rewind.messagesAffected', 'messages affected')})
                        </span>
                      )}
                    </li>
                    <li>{t('rewind.historyKept', 'Conversation history will be kept')}</li>
                  </ul>
                </div>
              </div>

              <p className="rewind-note">
                {t('rewind.cannotUndo', 'This action cannot be undone.')}
              </p>
            </>
          )}
        </div>
        <div className="confirm-dialog-footer">
          {isLoading ? (
            <button className="confirm-dialog-button cancel-button" onClick={onCancel}>
              {t('common.close', 'Close')}
            </button>
          ) : (
            <>
              <button className="confirm-dialog-button cancel-button" onClick={onCancel}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                className="confirm-dialog-button confirm-button rewind-confirm-button"
                onClick={handleConfirm}
                autoFocus
              >
                {t('rewind.restoreFiles', 'Restore Files')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default RewindDialog;
