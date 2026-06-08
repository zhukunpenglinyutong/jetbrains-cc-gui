import {useState} from 'react';
import styles from './style.module.less';
import {useTranslation} from 'react-i18next';
import type {DiffThemeMode} from '../../../utils/diffTheme';
import type {UiFontConfig} from '../hooks/useSettingsBasicActions';
import AppearanceTab from './AppearanceTab';
import BehaviorTab from './BehaviorTab';
import EnvironmentTab from './EnvironmentTab';

type BasicTab = 'appearance' | 'behavior' | 'environment';

const BASIC_TABS: { key: BasicTab; icon: string; labelKey: string }[] = [
  { key: 'appearance', icon: 'palette', labelKey: 'settings.basic.tabs.appearance' },
  { key: 'behavior', icon: 'zap', labelKey: 'settings.basic.tabs.behavior' },
  { key: 'environment', icon: 'wrench', labelKey: 'settings.basic.tabs.environment' },
];

// SVG icon paths for sub-tabs (Lucide-style, 24×24 viewBox, stroke-based)
const subTabIconPaths: Record<string, string> = {
  // Palette / Color
  palette:
    '<circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="10.5" r="2.5" fill="currentColor" stroke="none" opacity="0.3"/><circle cx="8.5" cy="7.5" r="2.5" fill="currentColor" stroke="none" opacity="0.3"/><circle cx="6.5" cy="12.5" r="2.5" fill="currentColor" stroke="none" opacity="0.3"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.04-.23-.29-.38-.63-.38-1.04C12.73 17.56 13.57 17 14.5 17H16c3.31 0 6-2.69 6-6 0-5.17-4.36-9-10-9z"/>',
  // Zap / Lightning
  zap:
    '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  // Wrench / Tool
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
};

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
  editorFontConfig?: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
  };
  uiFontConfig?: UiFontConfig;
  onUiFontSelectionChange?: (selection: string) => void;
  onSaveUiFontCustomPath?: (path: string) => void;
  onBrowseUiFontFile?: () => void;
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
  // Diff theme configuration
  diffTheme?: DiffThemeMode;
  onDiffThemeChange?: (theme: DiffThemeMode) => void;
  // Diff expanded by default configuration
  diffExpandedByDefault?: boolean;
  onDiffExpandedByDefaultChange?: (enabled: boolean) => void;
  // AI commit generation configuration
  commitGenerationEnabled?: boolean;
  onCommitGenerationEnabledChange?: (enabled: boolean) => void;
  // Status bar widget configuration
  statusBarWidgetEnabled?: boolean;
  onStatusBarWidgetEnabledChange?: (enabled: boolean) => void;
  // AI title generation configuration
  aiTitleGenerationEnabled?: boolean;
  onAiTitleGenerationEnabledChange?: (enabled: boolean) => void;
  // New-session confirm dialog (positive semantics: true = shown)
  newSessionConfirmEnabled?: boolean;
  onNewSessionConfirmEnabledChange?: (enabled: boolean) => void;
  // Task completion notification configuration
  taskCompletionNotificationEnabled?: boolean;
  onTaskCompletionNotificationEnabledChange?: (enabled: boolean) => void;
  // Invocation mode configuration
  invocationMode?: 'sdk' | 'cli';
  onInvocationModeChange?: (mode: 'sdk' | 'cli') => void;
  cliPath?: string;
  onCliPathChange?: (path: string) => void;
  // Permission dialog timeout configuration
  permissionDialogTimeoutSeconds?: number;
  onPermissionDialogTimeoutChange?: (seconds: number) => void;
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
            <span className={styles.tabIcon}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                dangerouslySetInnerHTML={{ __html: subTabIconPaths[tab.icon] || '' }}
              />
            </span>
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
          uiFontConfig={props.uiFontConfig}
          onUiFontSelectionChange={props.onUiFontSelectionChange}
          onSaveUiFontCustomPath={props.onSaveUiFontCustomPath}
          onBrowseUiFontFile={props.onBrowseUiFontFile}
          chatBgColor={props.chatBgColor}
          onChatBgColorChange={props.onChatBgColorChange}
          userMsgColor={props.userMsgColor}
          onUserMsgColorChange={props.onUserMsgColorChange}
          diffTheme={props.diffTheme}
          onDiffThemeChange={props.onDiffThemeChange}
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
          commitGenerationEnabled={props.commitGenerationEnabled}
          onCommitGenerationEnabledChange={props.onCommitGenerationEnabledChange}
          statusBarWidgetEnabled={props.statusBarWidgetEnabled}
          onStatusBarWidgetEnabledChange={props.onStatusBarWidgetEnabledChange}
          aiTitleGenerationEnabled={props.aiTitleGenerationEnabled}
          onAiTitleGenerationEnabledChange={props.onAiTitleGenerationEnabledChange}
          newSessionConfirmEnabled={props.newSessionConfirmEnabled}
          onNewSessionConfirmEnabledChange={props.onNewSessionConfirmEnabledChange}
          taskCompletionNotificationEnabled={props.taskCompletionNotificationEnabled}
          onTaskCompletionNotificationEnabledChange={props.onTaskCompletionNotificationEnabledChange}
          permissionDialogTimeoutSeconds={props.permissionDialogTimeoutSeconds}
          onPermissionDialogTimeoutChange={props.onPermissionDialogTimeoutChange}
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
          invocationMode={props.invocationMode}
          onInvocationModeChange={props.onInvocationModeChange}
          cliPath={props.cliPath}
          onCliPathChange={props.onCliPathChange}
        />
      )}
    </div>
  );
};

export default BasicConfigSection;
