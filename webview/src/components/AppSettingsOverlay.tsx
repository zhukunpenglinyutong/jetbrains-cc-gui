import SettingsView from './settings';
import { useUIState } from '../contexts/UIStateContext';

/**
 * Settings pass-through props — identical to the SettingsView props App.tsx
 * wires today (SettingsViewProps is not exported, so the types are mirrored
 * here).
 */
interface AppSettingsOverlayProps {
  currentProvider: 'claude' | 'codex' | string;
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  sendShortcut?: 'enter' | 'cmdEnter';
  onSendShortcutChange?: (shortcut: 'enter' | 'cmdEnter') => void;
  autoOpenFileEnabled?: boolean;
  onAutoOpenFileEnabledChange?: (enabled: boolean) => void;
  permissionDialogTimeoutSeconds?: number;
  onPermissionDialogTimeoutChange?: (seconds: number) => void;
}

/**
 * Settings overlay region extracted from App.tsx — mounts SettingsView with
 * the navigation props from UIStateContext plus the pass-through settings
 * props from the model/provider state.
 */
export const AppSettingsOverlay = (props: AppSettingsOverlayProps) => {
  const { setCurrentView, settingsInitialTab, settingsProviderSubTab } = useUIState();

  return (
    <SettingsView
      onClose={() => setCurrentView('chat')}
      initialTab={settingsInitialTab}
      initialProviderSubTab={settingsProviderSubTab}
      {...props}
    />
  );
};
