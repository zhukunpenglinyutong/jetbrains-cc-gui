import { useCallback } from 'react';
import type { TFunction } from 'i18next';

export interface HistoryConvertButtonProps {
  sessionId: string;
  entrypoint: string;
  t: TFunction;
  onConvertToCliSession: (sessionId: string) => void;
}

export const HistoryConvertButton = ({
  sessionId,
  entrypoint,
  t,
  onConvertToCliSession,
}: HistoryConvertButtonProps) => {
  const handleConvertToCliSession = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onConvertToCliSession(sessionId);
  }, [onConvertToCliSession, sessionId]);

  return (
    <button
      className={`history-convert-btn history-convert-${entrypoint}`}
      onClick={handleConvertToCliSession}
      title={t('history.convertToCliSession')}
      aria-label={t('history.convertToCliSession')}
    >
      <span className="codicon codicon-arrow-swap"></span>
      {t('history.convertButton')}
    </button>
  );
};
