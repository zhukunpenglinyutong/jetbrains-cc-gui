import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

/** Upward-opening custom select for sound selection (avoids JCEF clipping) */
const SoundSelectUpward = ({
  value,
  onChange,
  options,
  onTestSound,
  testSoundLabel,
}: {
  value: string;
  onChange: (val: string) => void;
  options: { value: string; label: string }[];
  onTestSound: () => void;
  testSoundLabel: string;
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, handleClickOutside]);

  return (
    <div className={styles.soundSelectRow}>
      <div className={styles.upwardSelect} ref={containerRef}>
        <button
          type="button"
          className={`${styles.upwardSelectTrigger} ${open ? styles.open : ''}`}
          onClick={() => setOpen((prev) => !prev)}
        >
          {selectedLabel}
        </button>
        {open && (
          <div className={styles.upwardSelectDropdown}>
            {options.map((opt) => (
              <div
                key={opt.value}
                className={`${styles.upwardSelectOption} ${opt.value === value ? styles.selected : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                {opt.label}
              </div>
            ))}
          </div>
        )}
      </div>
      <button
        className={styles.soundTestBtn}
        onClick={onTestSound}
        title={testSoundLabel}
      >
        <span className="codicon codicon-play" />
      </button>
    </div>
  );
};

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
}: BehaviorTabProps) => {
  const { t } = useTranslation();

  const soundOptions = useMemo(() => [
    { value: 'default', label: t('settings.basic.soundNotification.soundDefault') },
    { value: 'chime', label: t('settings.basic.soundNotification.soundChime') },
    { value: 'bell', label: t('settings.basic.soundNotification.soundBell') },
    { value: 'ding', label: t('settings.basic.soundNotification.soundDing') },
    { value: 'success', label: t('settings.basic.soundNotification.soundSuccess') },
    { value: 'custom', label: t('settings.basic.soundNotification.soundCustom') },
  ], [t]);

  return (
    <div className={styles.tabContent}>
      {/* Send shortcut configuration */}
      <div className={styles.sendShortcutSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-keyboard" />
          <span className={styles.fieldLabel}>{t('settings.basic.sendShortcut.label')}</span>
        </div>
        <div className={styles.themeGrid}>
          <div
            className={`${styles.themeCard} ${sendShortcut === 'enter' ? styles.active : ''}`}
            onClick={() => onSendShortcutChange('enter')}
          >
            {sendShortcut === 'enter' && (
              <div className={styles.checkBadge}>
                <span className="codicon codicon-check" />
              </div>
            )}
            <div className={styles.themeCardTitle}>{t('settings.basic.sendShortcut.enter')}</div>
            <div className={styles.themeCardDesc}>{t('settings.basic.sendShortcut.enterDesc')}</div>
          </div>

          <div
            className={`${styles.themeCard} ${sendShortcut === 'cmdEnter' ? styles.active : ''}`}
            onClick={() => onSendShortcutChange('cmdEnter')}
          >
            {sendShortcut === 'cmdEnter' && (
              <div className={styles.checkBadge}>
                <span className="codicon codicon-check" />
              </div>
            )}
            <div className={styles.themeCardTitle}>{t('settings.basic.sendShortcut.cmdEnter')}</div>
            <div className={styles.themeCardDesc}>{t('settings.basic.sendShortcut.cmdEnterDesc')}</div>
          </div>
        </div>
      </div>

      {/* Streaming configuration */}
      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-sync" />
          <span className={styles.fieldLabel}>{t('settings.basic.streaming.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={streamingEnabled}
            onChange={(e) => onStreamingEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {streamingEnabled
              ? t('settings.basic.streaming.enabled')
              : t('settings.basic.streaming.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.streaming.hint')}</span>
        </small>
      </div>

      {/* Auto open file configuration */}
      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-file" />
          <span className={styles.fieldLabel}>{t('settings.basic.autoOpenFile.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={autoOpenFileEnabled}
            onChange={(e) => onAutoOpenFileEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {autoOpenFileEnabled
              ? t('settings.basic.autoOpenFile.enabled')
              : t('settings.basic.autoOpenFile.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.autoOpenFile.hint')}</span>
        </small>
      </div>

      {/* Diff expanded by default configuration */}
      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-diff" />
          <span className={styles.fieldLabel}>{t('settings.basic.diffExpanded.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={diffExpandedByDefault}
            onChange={(e) => onDiffExpandedByDefaultChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {diffExpandedByDefault
              ? t('settings.basic.diffExpanded.enabled')
              : t('settings.basic.diffExpanded.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.diffExpanded.hint')}</span>
        </small>
      </div>

      {/* AI commit generation toggle */}
      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-git-commit" />
          <span className={styles.fieldLabel}>{t('settings.basic.commitGeneration.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={commitGenerationEnabled}
            onChange={(e) => onCommitGenerationEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {commitGenerationEnabled
              ? t('settings.basic.commitGeneration.enabled')
              : t('settings.basic.commitGeneration.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.commitGeneration.hint')}</span>
        </small>
      </div>

      {/* Status bar widget toggle */}
      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-layout-statusbar" />
          <span className={styles.fieldLabel}>{t('settings.basic.statusBarWidget.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={statusBarWidgetEnabled}
            onChange={(e) => onStatusBarWidgetEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {statusBarWidgetEnabled
              ? t('settings.basic.statusBarWidget.enabled')
              : t('settings.basic.statusBarWidget.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.statusBarWidget.hint')}</span>
        </small>
      </div>

      {/* Task completion notification toggle */}
      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-bell" />
          <span className={styles.fieldLabel}>{t('settings.basic.taskCompletionNotification.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={taskCompletionNotificationEnabled}
            onChange={(e) => onTaskCompletionNotificationEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {taskCompletionNotificationEnabled
              ? t('settings.basic.taskCompletionNotification.enabled')
              : t('settings.basic.taskCompletionNotification.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.taskCompletionNotification.hint')}</span>
        </small>
      </div>

      {/* AI session title generation toggle */}
      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-sparkle" />
          <span className={styles.fieldLabel}>{t('settings.other.aiTitleGeneration.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={aiTitleGenerationEnabled}
            onChange={(e) => onAiTitleGenerationEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {aiTitleGenerationEnabled
              ? t('settings.other.aiTitleGeneration.enabled')
              : t('settings.other.aiTitleGeneration.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.other.aiTitleGeneration.hint')}</span>
        </small>
      </div>

      {/* Sound notification */}
      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-unmute" />
          <span className={styles.fieldLabel}>{t('settings.basic.soundNotification.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={soundNotificationEnabled}
            onChange={(e) => onSoundNotificationEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {soundNotificationEnabled
              ? t('settings.basic.soundNotification.enabled')
              : t('settings.basic.soundNotification.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.soundNotification.hint')}</span>
        </small>

        {soundNotificationEnabled && (
          <div className={styles.customSoundSection}>
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
          </div>
        )}
      </div>
    </div>
  );
};

export default BehaviorTab;
