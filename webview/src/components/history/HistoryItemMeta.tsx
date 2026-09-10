import type { TFunction } from 'i18next';
import type { HistorySessionSummary } from '../../types';
import { formatFileSize } from './historyItemUtils';
import { HistoryEntrypointBadge } from './HistoryEntrypointBadge';
import { HistorySessionIdCopy } from './HistorySessionIdCopy';
import { HistoryConvertButton } from './HistoryConvertButton';

// Entrypoints the backend conversion service actually knows how to rewrite
// (SessionConversionService only matches sdk-cli / claude-vscode patterns).
const CONVERTIBLE_ENTRYPOINTS = new Set(['sdk-cli', 'claude-vscode']);

export interface HistoryItemMetaProps {
  session: HistorySessionSummary;
  isCopied: boolean;
  isCopyFailed: boolean;
  isActiveSession: boolean;
  t: TFunction;
  onCopySessionId: (sessionId: string) => void;
  onConvertToCliSession: (sessionId: string) => void;
}

export const HistoryItemMeta = ({
  session,
  isCopied,
  isCopyFailed,
  isActiveSession,
  t,
  onCopySessionId,
  onConvertToCliSession,
}: HistoryItemMetaProps) => {
  const fileSize = session.fileSize ? formatFileSize(session.fileSize) : null;
  const entrypoint = session.entrypoint && session.entrypoint !== 'cli' && session.entrypoint !== 'remote'
    ? session.entrypoint
    : null;
  // Converting the session this window is still chatting in would race with the
  // SDK process appending to the jsonl file, so hide the button for it.
  const showConvertButton = !isActiveSession
    && session.entrypoint != null
    && CONVERTIBLE_ENTRYPOINTS.has(session.entrypoint);

  return (
    <div className="history-item-meta">
      <span>{t('history.messageCount', { count: session.messageCount })}</span>
      {fileSize ? (
        <>
          <span className="history-meta-dot">•</span>
          <span className={fileSize.isMB ? 'history-filesize-large' : ''}>{fileSize.text}</span>
        </>
      ) : null}
      {entrypoint ? <HistoryEntrypointBadge entrypoint={entrypoint} t={t} /> : null}
      <HistorySessionIdCopy
        sessionId={session.sessionId}
        isCopied={isCopied}
        isCopyFailed={isCopyFailed}
        t={t}
        onCopySessionId={onCopySessionId}
      />
      {showConvertButton && session.entrypoint ? (
        <HistoryConvertButton
          sessionId={session.sessionId}
          entrypoint={session.entrypoint}
          t={t}
          onConvertToCliSession={onConvertToCliSession}
        />
      ) : null}
    </div>
  );
};
