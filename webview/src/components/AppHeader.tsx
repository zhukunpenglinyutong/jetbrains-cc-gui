import { useTranslation } from 'react-i18next';
import { ChatHeader } from './ChatHeader';
import { sendBridgeEvent } from '../utils/bridge';
import { useSession } from '../contexts/SessionContext';
import { useUIState } from '../contexts/UIStateContext';

interface AppHeaderProps {
  sessionTitle: string;
  onNewSession: () => void;
  onUpdateHistoryTitle: (sessionId: string, newTitle: string) => void;
  /** Regenerate the current session's AI title (Claude sessions only). */
  onRegenerateTitle: (sessionId: string) => void;
  regeneratingTitleSessionIds: ReadonlySet<string>;
  canRegenerateTitle: boolean;
}

/**
 * Header region extracted from App.tsx — wires view navigation, session
 * actions, and inline title editing into ChatHeader. View/session state is
 * consumed from contexts directly (same convention as ChatScreen).
 */
export const AppHeader = ({ sessionTitle, onNewSession, onUpdateHistoryTitle, onRegenerateTitle, regeneratingTitleSessionIds, canRegenerateTitle }: AppHeaderProps) => {
  const { t } = useTranslation();
  const {
    currentView, setCurrentView,
    setSettingsInitialTab, setSettingsProviderSubTab,
    setSearchOpen,
  } = useUIState();
  const { currentSessionId, setCustomSessionTitle } = useSession();

  // The chat-header refresh button only exists for Claude sessions with an
  // active id; the spinner reflects the shared per-session regeneration state.
  const handleRegenerateTitle = canRegenerateTitle && currentSessionId
    ? () => onRegenerateTitle(currentSessionId)
    : undefined;

  return (
    <ChatHeader
      currentView={currentView}
      sessionTitle={sessionTitle}
      t={t}
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
      onRegenerateTitle={handleRegenerateTitle}
      isRegeneratingTitle={currentSessionId != null && regeneratingTitleSessionIds.has(currentSessionId)}
      onTitleChange={(newTitle) => {
        setCustomSessionTitle(newTitle);
        if (currentSessionId) {
          onUpdateHistoryTitle(currentSessionId, newTitle);
        }
      }}
    />
  );
};
