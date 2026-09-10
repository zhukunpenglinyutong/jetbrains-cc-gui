import { useCallback } from 'react';
import type { TFunction } from 'i18next';

export interface HistorySessionIdCopyProps {
  sessionId: string;
  isCopied: boolean;
  isCopyFailed: boolean;
  t: TFunction;
  onCopySessionId: (sessionId: string) => void;
}

export const HistorySessionIdCopy = ({
  sessionId,
  isCopied,
  isCopyFailed,
  t,
  onCopySessionId,
}: HistorySessionIdCopyProps) => {
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onCopySessionId(sessionId);
  }, [onCopySessionId, sessionId]);

  return (
    <>
      <span className="history-meta-dot">•</span>
      <div className="history-session-id-container">
        <span
          className="history-session-id"
          title={sessionId}
        >
          {sessionId.slice(0, 8)}
        </span>
        <button
          className={`history-copy-id-btn ${isCopied ? 'copied' : ''} ${isCopyFailed ? 'failed' : ''}`}
          onClick={handleCopy}
          title={isCopied ? t('history.sessionIdCopied') : isCopyFailed ? t('history.copyFailed') : t('history.copySessionId')}
          aria-label={t('history.copySessionId')}
        >
          <span className={`codicon ${isCopied ? 'codicon-check' : isCopyFailed ? 'codicon-error' : 'codicon-copy'}`}></span>
        </button>
      </div>
    </>
  );
};
