import { useTranslation } from 'react-i18next';
import { ChatHeader } from './ChatHeader';
import { sendBridgeEvent } from '../utils/bridge';
import { useSession } from '../contexts/SessionContext';
import { useUIState } from '../contexts/UIStateContext';
import { useActiveSessionEntrypoint } from '../hooks/useActiveSessionEntrypoint';
import { CONVERTIBLE_ENTRYPOINTS } from './history/historyItemUtils';

interface AppHeaderProps {
  sessionTitle: string;
  onNewSession: () => void;
  onUpdateHistoryTitle: (sessionId: string, newTitle: string) => void;
}

/**
 * Header region extracted from App.tsx — wires view navigation, session
 * actions, and inline title editing into ChatHeader. View/session state is
 * consumed from contexts directly (same convention as ChatScreen).
 */
export const AppHeader = ({ sessionTitle, onNewSession, onUpdateHistoryTitle }: AppHeaderProps) => {
  const { t } = useTranslation();
  const {
    currentView, setCurrentView,
    setSettingsInitialTab, setSettingsProviderSubTab,
    setSearchOpen,
  } = useUIState();
  const { currentSessionId, setCustomSessionTitle, historyData } = useSession();

  // The snapshot the hint reads from is otherwise only filled by a manual visit to
  // the history view, which would hide the hint from its primary audience: a session
  // the SDK just created, in a window the user never browsed history in. The hook
  // warms that snapshot once per live session and stops as soon as it answers.
  useActiveSessionEntrypoint(currentView === 'chat');

  // The active session can never be converted while it is running (the SDK still
  // appends to its jsonl), so the header shows a hint rather than a button that
  // would only ever fail. Whether the session is convertible at all comes from the
  // history snapshot the webview already holds — no extra round-trip. A session the
  // snapshot does not know yet falls back to no hint rather than a guess.
  const activeSession = historyData?.sessions?.find(s => s.sessionId === currentSessionId);
  const convertHintVisible = currentView === 'chat'
    && currentSessionId != null
    && activeSession?.entrypoint != null
    && CONVERTIBLE_ENTRYPOINTS.has(activeSession.entrypoint);

  return (
    <ChatHeader
      currentView={currentView}
      sessionTitle={sessionTitle}
      t={t}
      convertHintVisible={convertHintVisible}
      onBack={() => setCurrentView('chat')}
      onNewSession={onNewSession}
      onNewTab={() => sendBridgeEvent('create_new_tab')}
      onHistory={() => setCurrentView('history')}
      onSettings={() => {
        setSettingsInitialTab(undefined);
        setSettingsProviderSubTab(undefined);
        setCurrentView('settings');
      }}
      onOpenSearch={() => setSearchOpen(true)}
      titleEditable
      onTitleChange={(newTitle) => {
        setCustomSessionTitle(newTitle);
        if (currentSessionId) {
          onUpdateHistoryTitle(currentSessionId, newTitle);
        }
      }}
    />
  );
};
