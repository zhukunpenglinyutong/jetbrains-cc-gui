import { useTranslation } from 'react-i18next';
import type { ToastMessage } from '../Toast';
import BasicConfigSection from './BasicConfigSection';
import { setNewSessionConfirmEnabled as persistNewSessionConfirmEnabled } from '../../utils/skipNewSessionConfirm';
import type {
  UseSettingsThemeSyncReturn,
  UseSettingsBasicActionsReturn,
} from './hooks';

interface BasicTabProps {
  themeSync: UseSettingsThemeSyncReturn;
  basicActions: UseSettingsBasicActionsReturn;
  addToast: (message: string, type?: ToastMessage['type']) => void;
}

const BasicTab = ({ themeSync, basicActions, addToast }: BasicTabProps) => {
  const { t } = useTranslation();

  return (
    <BasicConfigSection
      theme={themeSync.themePreference}
      onThemeChange={themeSync.setThemePreference}
      fontSizeLevel={themeSync.fontSizeLevel}
      onFontSizeLevelChange={themeSync.setFontSizeLevel}
      nodePath={basicActions.nodePath}
      onNodePathChange={basicActions.setNodePath}
      onSaveNodePath={basicActions.handleSaveNodePath}
      savingNodePath={basicActions.savingNodePath}
      nodeVersion={basicActions.nodeVersion}
      minNodeVersion={basicActions.minNodeVersion}
      claudeCliPath={basicActions.claudeCliPath}
      onClaudeCliPathChange={basicActions.setClaudeCliPath}
      onSaveClaudeCliPath={basicActions.handleSaveClaudeCliPath}
      savingClaudeCliPath={basicActions.savingClaudeCliPath}
      workingDirectory={basicActions.workingDirectory}
      onWorkingDirectoryChange={basicActions.setWorkingDirectory}
      onSaveWorkingDirectory={basicActions.handleSaveWorkingDirectory}
      savingWorkingDirectory={basicActions.savingWorkingDirectory}
      editorFontConfig={basicActions.editorFontConfig}
      uiFontConfig={basicActions.uiFontConfig}
      codeFontConfig={basicActions.codeFontConfig}
      onUiFontSelectionChange={basicActions.handleUiFontSelectionChange}
      onSaveUiFontCustomPath={basicActions.handleSaveUiFontCustomPath}
      onBrowseUiFontFile={basicActions.handleBrowseUiFontFile}
      onCodeFontSelectionChange={basicActions.handleCodeFontSelectionChange}
      onSaveCodeFontCustomPath={basicActions.handleSaveCodeFontCustomPath}
      onBrowseCodeFontFile={basicActions.handleBrowseCodeFontFile}
      streamingEnabled={basicActions.streamingEnabled}
      onStreamingEnabledChange={basicActions.handleStreamingEnabledChange}
      sendShortcut={basicActions.sendShortcut}
      onSendShortcutChange={basicActions.handleSendShortcutChange}
      autoOpenFileEnabled={basicActions.autoOpenFileEnabled}
      onAutoOpenFileEnabledChange={basicActions.handleAutoOpenFileEnabledChange}
      chatBgColor={themeSync.chatBgColor}
      onChatBgColorChange={themeSync.setChatBgColor}
      userMsgColor={themeSync.userMsgColor}
      onUserMsgColorChange={themeSync.setUserMsgColor}
      chatBarColor={themeSync.chatBarColor}
      onChatBarColorChange={themeSync.setChatBarColor}
      diffTheme={themeSync.diffTheme}
      onDiffThemeChange={themeSync.setDiffTheme}
      diffExpandedByDefault={basicActions.diffExpandedByDefault}
      onDiffExpandedByDefaultChange={basicActions.setDiffExpandedByDefault}
      commitGenerationEnabled={basicActions.commitGenerationEnabled}
      onCommitGenerationEnabledChange={(enabled) => {
        basicActions.handleCommitGenerationEnabledChange(enabled);
        addToast(t('toast.restartRequired'), 'warning');
      }}
      statusBarWidgetEnabled={basicActions.statusBarWidgetEnabled}
      onStatusBarWidgetEnabledChange={(enabled) => {
        basicActions.handleStatusBarWidgetEnabledChange(enabled);
        addToast(t('toast.restartRequired'), 'warning');
      }}
      aiTitleGenerationEnabled={basicActions.aiTitleGenerationEnabled}
      onAiTitleGenerationEnabledChange={basicActions.handleAiTitleGenerationEnabledChange}
      newSessionConfirmEnabled={!basicActions.skipNewSessionConfirm}
      onNewSessionConfirmEnabledChange={(enabled) => {
        // Optimistic local update so the toggle reflects instantly even if
        // the CustomEvent loops back. persistNewSessionConfirmEnabled writes
        // to localStorage and dispatches the sync event for other surfaces.
        basicActions.setSkipNewSessionConfirm(!enabled);
        persistNewSessionConfirmEnabled(enabled);
      }}
      soundNotificationEnabled={basicActions.soundNotificationEnabled}
      onSoundNotificationEnabledChange={basicActions.handleSoundNotificationEnabledChange}
      soundOnlyWhenUnfocused={basicActions.soundOnlyWhenUnfocused}
      onSoundOnlyWhenUnfocusedChange={basicActions.handleSoundOnlyWhenUnfocusedChange}
      selectedSound={basicActions.selectedSound}
      onSelectedSoundChange={basicActions.handleSelectedSoundChange}
      customSoundPath={basicActions.customSoundPath}
      onCustomSoundPathChange={basicActions.handleCustomSoundPathChange}
      onSaveCustomSoundPath={basicActions.handleSaveCustomSoundPath}
      onTestSound={basicActions.handleTestSound}
      onBrowseSound={basicActions.handleBrowseSound}
      taskCompletionNotificationEnabled={basicActions.taskCompletionNotificationEnabled}
      onTaskCompletionNotificationEnabledChange={basicActions.handleTaskCompletionNotificationEnabledChange}
      askUserQuestionNotificationEnabled={basicActions.askUserQuestionNotificationEnabled}
      onAskUserQuestionNotificationEnabledChange={basicActions.handleAskUserQuestionNotificationEnabledChange}
      detailedOutputEnabled={basicActions.detailedOutputEnabled}
      onDetailedOutputEnabledChange={basicActions.handleDetailedOutputEnabledChange}
      systemNotificationOnlyWhenUnfocused={basicActions.systemNotificationOnlyWhenUnfocused}
      onSystemNotificationOnlyWhenUnfocusedChange={basicActions.handleSystemNotificationOnlyWhenUnfocusedChange}
      askUserQuestionSoundNotificationEnabled={basicActions.askUserQuestionSoundNotificationEnabled}
      onAskUserQuestionSoundNotificationEnabledChange={basicActions.handleAskUserQuestionSoundNotificationEnabledChange}
      permissionDialogTimeoutSeconds={basicActions.permissionDialogTimeoutSeconds}
      onPermissionDialogTimeoutChange={basicActions.handlePermissionDialogTimeoutChange}
    />
  );
};

export default BasicTab;
