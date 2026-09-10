import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import { ToggleSettingSection } from './ToggleSettingSection';
import { SoundSelectUpward } from './SoundSelectUpward';

export interface NotificationSettingsGroupProps {
  soundNotificationEnabled: boolean;
  onSoundNotificationEnabledChange: (enabled: boolean) => void;
  soundOnlyWhenUnfocused: boolean;
  onSoundOnlyWhenUnfocusedChange: (enabled: boolean) => void;
  selectedSound: string;
  onSelectedSoundChange: (soundId: string) => void;
  customSoundPath: string;
  onCustomSoundPathChange: (path: string) => void;
  onSaveCustomSoundPath: () => void;
  onTestSound: () => void;
  onBrowseSound: () => void;
  taskCompletionNotificationEnabled: boolean;
  onTaskCompletionNotificationEnabledChange: (enabled: boolean) => void;
  askUserQuestionNotificationEnabled: boolean;
  onAskUserQuestionNotificationEnabledChange: (enabled: boolean) => void;
  systemNotificationOnlyWhenUnfocused: boolean;
  onSystemNotificationOnlyWhenUnfocusedChange: (enabled: boolean) => void;
  askUserQuestionSoundNotificationEnabled: boolean;
  onAskUserQuestionSoundNotificationEnabledChange: (enabled: boolean) => void;
}

/** Message notification settings (grouped): system + sound toggles and their detail settings. */
export function NotificationSettingsGroup({
  soundNotificationEnabled,
  onSoundNotificationEnabledChange,
  soundOnlyWhenUnfocused,
  onSoundOnlyWhenUnfocusedChange,
  selectedSound,
  onSelectedSoundChange,
  customSoundPath,
  onCustomSoundPathChange,
  onSaveCustomSoundPath,
  onTestSound,
  onBrowseSound,
  taskCompletionNotificationEnabled,
  onTaskCompletionNotificationEnabledChange,
  askUserQuestionNotificationEnabled,
  onAskUserQuestionNotificationEnabledChange,
  systemNotificationOnlyWhenUnfocused,
  onSystemNotificationOnlyWhenUnfocusedChange,
  askUserQuestionSoundNotificationEnabled,
  onAskUserQuestionSoundNotificationEnabledChange,
}: NotificationSettingsGroupProps) {
  const { t } = useTranslation();

  const soundOptions = useMemo(() => [
    { value: 'default', label: t('settings.basic.soundNotification.soundDefault') },
    { value: 'chime', label: t('settings.basic.soundNotification.soundChime') },
    { value: 'bell', label: t('settings.basic.soundNotification.soundBell') },
    { value: 'ding', label: t('settings.basic.soundNotification.soundDing') },
    { value: 'success', label: t('settings.basic.soundNotification.soundSuccess') },
    { value: 'custom', label: t('settings.basic.soundNotification.soundCustom') },
  ], [t]);
  const hasAnySystemNotificationEnabled =
    taskCompletionNotificationEnabled || askUserQuestionNotificationEnabled;
  const hasAnySoundNotificationEnabled = soundNotificationEnabled || askUserQuestionSoundNotificationEnabled;
  const hasAnyNotificationDetailSetting =
    hasAnySystemNotificationEnabled || hasAnySoundNotificationEnabled;

  return (
    <>
      {/* AskUserQuestion reminder notification toggle */}
      <ToggleSettingSection
        icon="codicon-comment-discussion"
        label={t('settings.basic.askUserQuestionNotification.label')}
        checked={askUserQuestionNotificationEnabled}
        onChange={onAskUserQuestionNotificationEnabledChange}
        enabledLabel={t('settings.basic.askUserQuestionNotification.enabled')}
        disabledLabel={t('settings.basic.askUserQuestionNotification.disabled')}
        hint={t('settings.basic.askUserQuestionNotification.hint')}
      />

      {/* AskUserQuestion reminder sound notification toggle */}
      <ToggleSettingSection
        icon="codicon-unmute"
        label={t('settings.basic.askUserQuestionSoundNotification.label')}
        checked={askUserQuestionSoundNotificationEnabled}
        onChange={onAskUserQuestionSoundNotificationEnabledChange}
        enabledLabel={t('settings.basic.askUserQuestionSoundNotification.enabled')}
        disabledLabel={t('settings.basic.askUserQuestionSoundNotification.disabled')}
        hint={t('settings.basic.askUserQuestionSoundNotification.hint')}
      />

      {/* Task completion notification toggle */}
      <ToggleSettingSection
        icon="codicon-bell"
        label={t('settings.basic.taskCompletionNotification.label')}
        checked={taskCompletionNotificationEnabled}
        onChange={onTaskCompletionNotificationEnabledChange}
        enabledLabel={t('settings.basic.taskCompletionNotification.enabled')}
        disabledLabel={t('settings.basic.taskCompletionNotification.disabled')}
        hint={t('settings.basic.taskCompletionNotification.hint')}
      />

      {/* Sound notification */}
      <ToggleSettingSection
        icon="codicon-unmute"
        label={t('settings.basic.soundNotification.label')}
        checked={soundNotificationEnabled}
        onChange={onSoundNotificationEnabledChange}
        enabledLabel={t('settings.basic.soundNotification.enabled')}
        disabledLabel={t('settings.basic.soundNotification.disabled')}
        hint={t('settings.basic.soundNotification.hint')}
      />

      {hasAnyNotificationDetailSetting && (
        <div className={styles.customSoundSection}>
          {hasAnySystemNotificationEnabled && (
            <div className={styles.soundOnlyWhenUnfocusedSection}>
              <div className={styles.fieldHeader}>
                <span className="codicon codicon-eye-closed" />
                <span className={styles.fieldLabel}>{t('settings.basic.systemNotificationOnlyWhenUnfocused.label')}</span>
              </div>
              <label className={styles.toggleWrapper}>
                <input
                  type="checkbox"
                  className={styles.toggleInput}
                  checked={systemNotificationOnlyWhenUnfocused}
                  onChange={(e) => onSystemNotificationOnlyWhenUnfocusedChange(e.target.checked)}
                />
                <span className={styles.toggleSlider} />
                <span className={styles.toggleLabel}>
                  {systemNotificationOnlyWhenUnfocused
                    ? t('settings.basic.systemNotificationOnlyWhenUnfocused.enabled')
                    : t('settings.basic.systemNotificationOnlyWhenUnfocused.disabled')}
                </span>
              </label>
              <small className={styles.formHint}>
                <span className="codicon codicon-info" />
                <span>{t('settings.basic.systemNotificationOnlyWhenUnfocused.hint')}</span>
              </small>
            </div>
          )}

          {hasAnySoundNotificationEnabled && (
            <>
              <div className={styles.soundOnlyWhenUnfocusedSection}>
                <div className={styles.fieldHeader}>
                  <span className="codicon codicon-eye-closed" />
                  <span className={styles.fieldLabel}>{t('settings.basic.soundNotification.onlyWhenUnfocused')}</span>
                </div>
                <label className={styles.toggleWrapper}>
                  <input
                    type="checkbox"
                    className={styles.toggleInput}
                    checked={soundOnlyWhenUnfocused}
                    onChange={(e) => onSoundOnlyWhenUnfocusedChange(e.target.checked)}
                  />
                  <span className={styles.toggleSlider} />
                  <span className={styles.toggleLabel}>
                    {soundOnlyWhenUnfocused
                      ? t('settings.basic.soundNotification.enabled')
                      : t('settings.basic.soundNotification.disabled')}
                  </span>
                </label>
                <small className={styles.formHint}>
                  <span className="codicon codicon-info" />
                  <span>{t('settings.basic.soundNotification.onlyWhenUnfocusedHint')}</span>
                </small>
              </div>

              <div className={styles.fieldHeader}>
                <span className="codicon codicon-library" />
                <span className={styles.fieldLabel}>{t('settings.basic.soundNotification.selectSound')}</span>
              </div>
              <SoundSelectUpward
                value={selectedSound}
                onChange={onSelectedSoundChange}
                options={soundOptions}
                onTestSound={onTestSound}
                testSoundLabel={t('settings.basic.soundNotification.testSound')}
              />

              {selectedSound === 'custom' && (
                <div className={styles.customSoundFileSection}>
                  <div className={styles.fieldHeader}>
                    <span className="codicon codicon-file-media" />
                    <span className={styles.fieldLabel}>{t('settings.basic.soundNotification.customSound')}</span>
                  </div>
                  <div className={styles.nodePathInputWrapper}>
                    <input
                      type="text"
                      className={styles.nodePathInput}
                      placeholder={t('settings.basic.soundNotification.customSoundPlaceholder')}
                      value={customSoundPath}
                      onChange={(e) => onCustomSoundPathChange(e.target.value)}
                    />
                    <button
                      className={styles.saveBtn}
                      onClick={onBrowseSound}
                      title={t('settings.basic.soundNotification.browse')}
                    >
                      <span className="codicon codicon-folder-opened" />
                    </button>
                    <button
                      className={styles.saveBtn}
                      onClick={onSaveCustomSoundPath}
                    >
                      {t('common.save')}
                    </button>
                  </div>
                  <small className={styles.formHint}>
                    <span className="codicon codicon-info" />
                    <span>{t('settings.basic.soundNotification.customSoundHint')}</span>
                  </small>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
