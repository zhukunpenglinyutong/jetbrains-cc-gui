import { useState } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import AppearanceTab from './AppearanceTab';
import BehaviorTab from './BehaviorTab';
import EnvironmentTab from './EnvironmentTab';

type BasicTab = 'appearance' | 'behavior' | 'environment';

const BASIC_TABS: { key: BasicTab; icon: string; labelKey: string }[] = [
  { key: 'appearance', icon: 'codicon-symbol-color', labelKey: 'settings.basic.tabs.appearance' },
  { key: 'behavior', icon: 'codicon-gear', labelKey: 'settings.basic.tabs.behavior' },
  { key: 'environment', icon: 'codicon-terminal', labelKey: 'settings.basic.tabs.environment' },
];

interface BasicConfigSectionProps {
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  fontSizeLevel: number;
  onFontSizeLevelChange: (level: number) => void;
  nodePath: string;
  onNodePathChange: (path: string) => void;
  onSaveNodePath: () => void;
  savingNodePath: boolean;
  nodeVersion?: string | null;
  minNodeVersion?: number;
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  onSaveWorkingDirectory?: () => void;
  savingWorkingDirectory?: boolean;
  // F-008: Tracker path
  trackerPath?: string;
  onTrackerPathChange?: (path: string) => void;
  onSaveTrackerPath?: () => void;
  savingTrackerPath?: boolean;
  trackerPathExists?: boolean;
  editorFontConfig?: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
  };
  // Streaming configuration
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  // Auto open file configuration
  autoOpenFileEnabled?: boolean;
  onAutoOpenFileEnabledChange?: (enabled: boolean) => void;
  // Send shortcut configuration
  sendShortcut?: 'enter' | 'cmdEnter';
  onSendShortcutChange?: (shortcut: 'enter' | 'cmdEnter') => void;
  // Chat background color configuration
  chatBgColor?: string;
  onChatBgColorChange?: (color: string) => void;
  // User message bubble color configuration
  userMsgColor?: string;
  onUserMsgColorChange?: (color: string) => void;
  // Diff expanded by default configuration
  diffExpandedByDefault?: boolean;
  onDiffExpandedByDefaultChange?: (enabled: boolean) => void;
  // Sound notification configuration
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
  streamingRenderTables?: boolean;
  onStreamingRenderTablesChange?: (enabled: boolean) => void;
  streamingRenderLists?: boolean;
  onStreamingRenderListsChange?: (enabled: boolean) => void;
}

const BasicConfigSection = (props: BasicConfigSectionProps) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<BasicTab>('appearance');

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.basic.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.basic.description')}</p>

      {/* Tab selector */}
      <div className={styles.basicTabSelector}>
        {BASIC_TABS.map((tab) => (
          <button
            key={tab.key}
            className={`${styles.basicTabBtn} ${activeTab === tab.key ? styles.active : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            <span className={`codicon ${tab.icon}`} />
            <span>{t(tab.labelKey)}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'appearance' && (
        <AppearanceTab
          theme={props.theme}
          onThemeChange={props.onThemeChange}
          fontSizeLevel={props.fontSizeLevel}
          onFontSizeLevelChange={props.onFontSizeLevelChange}
          editorFontConfig={props.editorFontConfig}
          chatBgColor={props.chatBgColor}
          onChatBgColorChange={props.onChatBgColorChange}
          userMsgColor={props.userMsgColor}
          onUserMsgColorChange={props.onUserMsgColorChange}
        />
      )}

      {activeTab === 'behavior' && (
        <BehaviorTab
          sendShortcut={props.sendShortcut}
          onSendShortcutChange={props.onSendShortcutChange}
          streamingEnabled={props.streamingEnabled}
          onStreamingEnabledChange={props.onStreamingEnabledChange}
          autoOpenFileEnabled={props.autoOpenFileEnabled}
          onAutoOpenFileEnabledChange={props.onAutoOpenFileEnabledChange}
          diffExpandedByDefault={props.diffExpandedByDefault}
          onDiffExpandedByDefaultChange={props.onDiffExpandedByDefaultChange}
          soundNotificationEnabled={props.soundNotificationEnabled}
          onSoundNotificationEnabledChange={props.onSoundNotificationEnabledChange}
          soundOnlyWhenUnfocused={props.soundOnlyWhenUnfocused}
          onSoundOnlyWhenUnfocusedChange={props.onSoundOnlyWhenUnfocusedChange}
          selectedSound={props.selectedSound}
          onSelectedSoundChange={props.onSelectedSoundChange}
          customSoundPath={props.customSoundPath}
          onCustomSoundPathChange={props.onCustomSoundPathChange}
          onSaveCustomSoundPath={props.onSaveCustomSoundPath}
          onTestSound={props.onTestSound}
          onBrowseSound={props.onBrowseSound}
          streamingRenderTables={props.streamingRenderTables}
          onStreamingRenderTablesChange={props.onStreamingRenderTablesChange}
          streamingRenderLists={props.streamingRenderLists}
          onStreamingRenderListsChange={props.onStreamingRenderListsChange}
        />
      )}

      {activeTab === 'environment' && (
        <EnvironmentTab
          nodePath={props.nodePath}
          onNodePathChange={props.onNodePathChange}
          onSaveNodePath={props.onSaveNodePath}
          savingNodePath={props.savingNodePath}
          nodeVersion={props.nodeVersion}
          minNodeVersion={props.minNodeVersion}
          workingDirectory={props.workingDirectory}
          onWorkingDirectoryChange={props.onWorkingDirectoryChange}
          onSaveWorkingDirectory={props.onSaveWorkingDirectory}
          savingWorkingDirectory={props.savingWorkingDirectory}
          trackerPath={props.trackerPath}
          onTrackerPathChange={props.onTrackerPathChange}
          onSaveTrackerPath={props.onSaveTrackerPath}
          savingTrackerPath={props.savingTrackerPath}
          trackerPathExists={props.trackerPathExists}
        />
      )}
    </div>
  );
};

export default BasicConfigSection;
