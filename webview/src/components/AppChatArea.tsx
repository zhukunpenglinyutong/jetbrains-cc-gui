import HistoryView from './history/HistoryView';
import { ChatScreen } from './ChatScreen';
import type { ChatScreenProps } from './ChatScreen';
import { useSession } from '../contexts/SessionContext';
import { useUIState } from '../contexts/UIStateContext';
import { useMessages } from '../contexts/MessagesContext';

/** HistoryView callbacks (HistoryViewProps is not exported; mirrored here). */
interface HistoryCallbacks {
  onLoadSession: (sessionId: string, provider?: string, model?: string, agent?: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onDeleteSessions: (sessionIds: string[]) => void;
  onExportSession: (sessionId: string, title: string) => void;
  onToggleFavorite: (sessionId: string) => void;
  onUpdateTitle: (sessionId: string, newTitle: string) => void;
  onConvertToCliSession: (sessionId: string) => void;
}

interface AppChatAreaProps extends ChatScreenProps, HistoryCallbacks {
  /** A native Codex turn is still active after the visible stream ended. */
  codexTurnActive?: boolean;
}

/**
 * Main chat area extracted from App.tsx — the chat screen (kept mounted while
 * browsing history so model catalog, scroll position, and draft attachments
 * survive history ↔ chat) plus the history view. View/session state is
 * consumed from contexts directly (same convention as ChatScreen).
 */
export const AppChatArea = (props: AppChatAreaProps) => {
  const { currentView } = useUIState();
  const { historyData, currentSessionId } = useSession();
  const { loading, streamingActive } = useMessages();
  const {
    onLoadSession,
    onDeleteSession,
    onDeleteSessions,
    onExportSession,
    onToggleFavorite,
    onUpdateTitle,
    onConvertToCliSession,
    codexTurnActive,
    ...chatScreenProps
  } = props;
  // Same notion of busy as the send queue: deleting must wait for every native phase.
  const currentSessionBusy = loading || streamingActive || Boolean(codexTurnActive)
    || Boolean(props.codexPlanExecutionPending) || Boolean(props.codexCompactionPending);

  return (
    <>
      {/* Keep ChatScreen mounted while browsing history so model catalog,
          scroll position, and draft attachments survive history ↔ chat. */}
      <div
        style={currentView === 'chat'
          ? { display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }
          : { display: 'none' }}
      >
        <ChatScreen {...chatScreenProps} />
      </div>
      {currentView === 'history' && (
        <HistoryView
          historyData={historyData}
          currentProvider={props.currentProvider}
          currentSessionId={currentSessionId}
          currentSessionBusy={currentSessionBusy}
          onLoadSession={onLoadSession}
          onDeleteSession={onDeleteSession}
          onDeleteSessions={onDeleteSessions}
          onExportSession={onExportSession}
          onToggleFavorite={onToggleFavorite}
          onUpdateTitle={onUpdateTitle}
          onConvertToCliSession={onConvertToCliSession}
        />
      )}
    </>
  );
};
