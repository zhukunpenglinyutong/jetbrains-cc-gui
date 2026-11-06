import { useMemo } from 'react';
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
  const { currentSessionId, historyData, setCustomSessionTitle } = useSession();

  // Manual-title detection mirrors the history rows: hasCustomTitle comes from
  // session-titles.json via HistoryLoadService. customSessionTitle is NOT a
  // usable signal here — loading any history session seeds it with the
  // displayed title (AI titles included), which hid the button on every
  // session switch.
  const hasManualTitle = useMemo(
    () => Boolean(currentSessionId && historyData?.sessions?.some(
      session => session.sessionId === currentSessionId && session.hasCustomTitle === true,
    )),
    [currentSessionId, historyData],
  );

  // The chat-header refresh button only exists for Claude sessions with an
  // active id and no manual title (a manual title wins over the AI title, so
  // a regeneration would never show its result); the spinner reflects the
  // shared per-session regeneration state.
  const handleRegenerateTitle = canRegenerateTitle && currentSessionId && !hasManualTitle
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
