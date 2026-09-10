import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../../../utils/permissionDialogTimeout';
import { PermissionDialogTimeoutSetting } from './PermissionDialogTimeoutSetting';
import { ToggleSettingSection } from './ToggleSettingSection';
import { SendShortcutSection } from './SendShortcutSection';
import { NotificationSettingsGroup } from './NotificationSettingsGroup';

export interface BehaviorTabProps {
  sendShortcut?: 'enter' | 'cmdEnter';
  onSendShortcutChange?: (shortcut: 'enter' | 'cmdEnter') => void;
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  autoOpenFileEnabled?: boolean;
  onAutoOpenFileEnabledChange?: (enabled: boolean) => void;
  diffExpandedByDefault?: boolean;
  onDiffExpandedByDefaultChange?: (enabled: boolean) => void;
  commitGenerationEnabled?: boolean;
  onCommitGenerationEnabledChange?: (enabled: boolean) => void;
  statusBarWidgetEnabled?: boolean;
  onStatusBarWidgetEnabledChange?: (enabled: boolean) => void;
  aiTitleGenerationEnabled?: boolean;
  onAiTitleGenerationEnabledChange?: (enabled: boolean) => void;
  /**
   * Whether the "create new session with existing messages" confirm dialog is
   * enabled (i.e. shown). Positive semantics: `true` = dialog shows, `false` =
   * silently create the new session. Default `true` to preserve safer behaviour
   * for upgrading users.
   */
  newSessionConfirmEnabled?: boolean;
  onNewSessionConfirmEnabledChange?: (enabled: boolean) => void;
  soundNotificationEnabled?: boolean;
  onSoundNotificationEnabledChange?: (enabled: boolean) => void;
  soundOnlyWhenUnfocused?: boolean;
  onSoundOnlyWhenUnfocusedChange?: (enabled: boolean) => void;
  selectedSound?: string;
  onSelectedSoundChange?: (soundId: string) => void;
  customSoundPath?: string;
  onCustomSoundPathChange?: (path: string) => void;
  onSaveCustomSoundPath?: () => void;
  onTestSound?: () => void;
  onBrowseSound?: () => void;
  taskCompletionNotificationEnabled?: boolean;
  onTaskCompletionNotificationEnabledChange?: (enabled: boolean) => void;
  askUserQuestionNotificationEnabled?: boolean;
  onAskUserQuestionNotificationEnabledChange?: (enabled: boolean) => void;
  detailedOutputEnabled?: boolean;
  onDetailedOutputEnabledChange?: (enabled: boolean) => void;
  systemNotificationOnlyWhenUnfocused?: boolean;
  onSystemNotificationOnlyWhenUnfocusedChange?: (enabled: boolean) => void;
  askUserQuestionSoundNotificationEnabled?: boolean;
  onAskUserQuestionSoundNotificationEnabledChange?: (enabled: boolean) => void;
  permissionDialogTimeoutSeconds?: number;
  onPermissionDialogTimeoutChange?: (seconds: number) => void;
}

const BehaviorTab = ({
  sendShortcut = 'enter',
  onSendShortcutChange = () => {},
  streamingEnabled = true,
  onStreamingEnabledChange = () => {},
  autoOpenFileEnabled = true,
  onAutoOpenFileEnabledChange = () => {},
  diffExpandedByDefault = false,
  onDiffExpandedByDefaultChange = () => {},
  commitGenerationEnabled = true,
  onCommitGenerationEnabledChange = () => {},
  statusBarWidgetEnabled = true,
  onStatusBarWidgetEnabledChange = () => {},
  aiTitleGenerationEnabled = true,
  onAiTitleGenerationEnabledChange = () => {},
  newSessionConfirmEnabled = true,
  onNewSessionConfirmEnabledChange = () => {},
  soundNotificationEnabled = false,
  onSoundNotificationEnabledChange = () => {},
  soundOnlyWhenUnfocused = false,
  onSoundOnlyWhenUnfocusedChange = () => {},
  selectedSound = 'default',
  onSelectedSoundChange = () => {},
  customSoundPath = '',
  onCustomSoundPathChange = () => {},
  onSaveCustomSoundPath = () => {},
  onTestSound = () => {},
  onBrowseSound = () => {},
  taskCompletionNotificationEnabled = false,
  onTaskCompletionNotificationEnabledChange = () => {},
  askUserQuestionNotificationEnabled = false,
  onAskUserQuestionNotificationEnabledChange = () => {},
  detailedOutputEnabled = false,
  onDetailedOutputEnabledChange = () => {},
  systemNotificationOnlyWhenUnfocused = false,
  onSystemNotificationOnlyWhenUnfocusedChange = () => {},
  askUserQuestionSoundNotificationEnabled = false,
  onAskUserQuestionSoundNotificationEnabledChange = () => {},
  permissionDialogTimeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  onPermissionDialogTimeoutChange = () => {},
}: BehaviorTabProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.tabContent}>
      {/* Send shortcut configuration */}
      <SendShortcutSection
        sendShortcut={sendShortcut}
        onSendShortcutChange={onSendShortcutChange}
      />

      <PermissionDialogTimeoutSetting
        permissionDialogTimeoutSeconds={permissionDialogTimeoutSeconds}
        onPermissionDialogTimeoutChange={onPermissionDialogTimeoutChange}
      />

      {/* Streaming configuration */}
      <ToggleSettingSection
        icon="codicon-sync"
        label={t('settings.basic.streaming.label')}
        checked={streamingEnabled}
        onChange={onStreamingEnabledChange}
        enabledLabel={t('settings.basic.streaming.enabled')}
        disabledLabel={t('settings.basic.streaming.disabled')}
        hint={t('settings.basic.streaming.hint')}
      />

      {/* Auto open file configuration */}
      <ToggleSettingSection
        icon="codicon-file"
        label={t('settings.basic.autoOpenFile.label')}
        checked={autoOpenFileEnabled}
        onChange={onAutoOpenFileEnabledChange}
        enabledLabel={t('settings.basic.autoOpenFile.enabled')}
        disabledLabel={t('settings.basic.autoOpenFile.disabled')}
        hint={t('settings.basic.autoOpenFile.hint')}
      />

      {/* Diff expanded by default configuration */}
      <ToggleSettingSection
        icon="codicon-diff"
        label={t('settings.basic.diffExpanded.label')}
        checked={diffExpandedByDefault}
        onChange={onDiffExpandedByDefaultChange}
        enabledLabel={t('settings.basic.diffExpanded.enabled')}
        disabledLabel={t('settings.basic.diffExpanded.disabled')}
        hint={t('settings.basic.diffExpanded.hint')}
      />

      {/* AI commit generation toggle */}
      <ToggleSettingSection
        icon="codicon-git-commit"
        label={t('settings.basic.commitGeneration.label')}
        checked={commitGenerationEnabled}
        onChange={onCommitGenerationEnabledChange}
        enabledLabel={t('settings.basic.commitGeneration.enabled')}
        disabledLabel={t('settings.basic.commitGeneration.disabled')}
        hint={t('settings.basic.commitGeneration.hint')}
      />

      {/* Status bar widget toggle */}
      <ToggleSettingSection
        icon="codicon-layout-statusbar"
        label={t('settings.basic.statusBarWidget.label')}
        checked={statusBarWidgetEnabled}
        onChange={onStatusBarWidgetEnabledChange}
        enabledLabel={t('settings.basic.statusBarWidget.enabled')}
        disabledLabel={t('settings.basic.statusBarWidget.disabled')}
        hint={t('settings.basic.statusBarWidget.hint')}
      />

      {/* AI session title generation toggle */}
      <ToggleSettingSection
        icon="codicon-sparkle"
        label={t('settings.other.aiTitleGeneration.label')}
        checked={aiTitleGenerationEnabled}
        onChange={onAiTitleGenerationEnabledChange}
        enabledLabel={t('settings.other.aiTitleGeneration.enabled')}
        disabledLabel={t('settings.other.aiTitleGeneration.disabled')}
        hint={t('settings.other.aiTitleGeneration.hint')}
      />

      {/* New-session confirm dialog toggle.
          Positive semantics throughout (no inversions in JSX) — the storage
          layer in utils/skipNewSessionConfirm.ts owns the negation. */}
      <ToggleSettingSection
        icon="codicon-comment-discussion"
        label={t('settings.basic.newSessionConfirm.label')}
        checked={newSessionConfirmEnabled}
        onChange={onNewSessionConfirmEnabledChange}
        enabledLabel={t('settings.basic.newSessionConfirm.enabled')}
        disabledLabel={t('settings.basic.newSessionConfirm.disabled')}
        hint={t('settings.basic.newSessionConfirm.hint')}
      />

      {/* Detailed output information toggle */}
      <ToggleSettingSection
        icon="codicon-output"
        label={t('settings.basic.detailedOutput.label')}
        checked={detailedOutputEnabled}
        onChange={onDetailedOutputEnabledChange}
        enabledLabel={t('settings.basic.detailedOutput.enabled')}
        disabledLabel={t('settings.basic.detailedOutput.disabled')}
        hint={t('settings.basic.detailedOutput.hint')}
      />

      {/* ===== Message notification settings (grouped) ===== */}
      <NotificationSettingsGroup
        soundNotificationEnabled={soundNotificationEnabled}
        onSoundNotificationEnabledChange={onSoundNotificationEnabledChange}
        soundOnlyWhenUnfocused={soundOnlyWhenUnfocused}
        onSoundOnlyWhenUnfocusedChange={onSoundOnlyWhenUnfocusedChange}
        selectedSound={selectedSound}
        onSelectedSoundChange={onSelectedSoundChange}
        customSoundPath={customSoundPath}
        onCustomSoundPathChange={onCustomSoundPathChange}
        onSaveCustomSoundPath={onSaveCustomSoundPath}
        onTestSound={onTestSound}
        onBrowseSound={onBrowseSound}
        taskCompletionNotificationEnabled={taskCompletionNotificationEnabled}
        onTaskCompletionNotificationEnabledChange={onTaskCompletionNotificationEnabledChange}
        askUserQuestionNotificationEnabled={askUserQuestionNotificationEnabled}
        onAskUserQuestionNotificationEnabledChange={onAskUserQuestionNotificationEnabledChange}
        systemNotificationOnlyWhenUnfocused={systemNotificationOnlyWhenUnfocused}
        onSystemNotificationOnlyWhenUnfocusedChange={onSystemNotificationOnlyWhenUnfocusedChange}
        askUserQuestionSoundNotificationEnabled={askUserQuestionSoundNotificationEnabled}
        onAskUserQuestionSoundNotificationEnabledChange={onAskUserQuestionSoundNotificationEnabledChange}
      />
    </div>
  );
};

export default BehaviorTab;
