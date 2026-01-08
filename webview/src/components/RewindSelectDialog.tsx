import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeMessage } from '../types';

export interface RewindableMessage {
  messageIndex: number;
  message: ClaudeMessage;
  displayContent: string;
  timestamp?: string;
  messagesAfterCount: number;
}

interface RewindSelectDialogProps {
  isOpen: boolean;
  rewindableMessages: RewindableMessage[];
  onSelect: (item: RewindableMessage) => void;
  onCancel: () => void;
}

const RewindSelectDialog = ({
  isOpen,
  rewindableMessages,
  onSelect,
  onCancel,
}: RewindSelectDialogProps) => {
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

  // Sort messages by index descending (most recent first)
  const sortedMessages = useMemo(() => {
    return [...rewindableMessages].sort((a, b) => b.messageIndex - a.messageIndex);
  }, [rewindableMessages]);

  if (!isOpen) {
    return null;
  }

  // Truncate message content for display
  const truncateContent = (content: string, maxLength: number = 60): string => {
    if (content.length <= maxLength) {
      return content;
    }
    return `${content.substring(0, maxLength)}...`;
  };

  return (
    <div className="confirm-dialog-overlay" onClick={onCancel}>
      <div className="confirm-dialog rewind-select-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">
          <h3 className="confirm-dialog-title">
            <span className="rewind-icon">&#x21BA;</span> {t('rewind.selectTitle', '选择回溯点')}
          </h3>
        </div>
        <div className="confirm-dialog-body rewind-select-body">
          {sortedMessages.length === 0 ? (
            <div className="rewind-select-empty">
              {t('rewind.noRewindableMessages', '当前会话中没有可回溯的消息')}
            </div>
          ) : (
            <div className="rewind-select-list">
              {sortedMessages.map((item, index) => (
                <div
                  key={item.messageIndex}
                  className="rewind-select-item"
                  onClick={() => onSelect(item)}
                >
                  <div className="rewind-select-item-content">
                    <span className="rewind-select-timestamp">[{sortedMessages.length - index}]</span>
                    <span className="rewind-select-text" title={item.displayContent}>
                      {truncateContent(item.displayContent)}
                    </span>
                  </div>
                  <div className="rewind-select-item-meta">
                    <span className="rewind-select-affected">
                      {item.messagesAfterCount} {t('rewind.messagesAffected', '条消息受影响')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="confirm-dialog-footer">
          <button className="confirm-dialog-button cancel-button" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RewindSelectDialog;
