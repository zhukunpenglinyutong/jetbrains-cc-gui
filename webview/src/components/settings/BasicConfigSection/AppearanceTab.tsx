import { useMemo } from 'react';
import styles from './style.module.less';
import type { DiffThemeMode } from '../../../utils/diffTheme';
import type { UiFontConfig, CodeFontConfig } from '../hooks/useSettingsBasicActions';
import ThemeSection from './ThemeSection';
import LanguageSection from './LanguageSection';
import FontSizeSection from './FontSizeSection';
import UiFontSection from './UiFontSection';
import CodeFontSection from './CodeFontSection';
import DiffThemeSection from './DiffThemeSection';
import ColorSettingSection from './ColorSettingSection';

// Preset colors (module-level constants to avoid recreating on each render)
const DARK_PRESETS = [
  { color: '#1e1e1e', label: 'Default' },
  { color: '#1a1b26', label: 'Tokyo Night' },
  { color: '#282c34', label: 'One Dark' },
  { color: '#2b2d30', label: 'JetBrains' },
  { color: '#0d1117', label: 'GitHub Dark' },
  { color: '#1e1f29', label: 'Dracula' },
  { color: '#262335', label: 'SynthWave' },
  { color: '#292d3e', label: 'Palenight' },
];

const LIGHT_PRESETS = [
  { color: '#ffffff', label: 'Default' },
  { color: '#fafafa', label: 'Soft White' },
  { color: '#f5f5f5', label: 'Light Gray' },
  { color: '#faf4ed', label: 'Rose Pine' },
  { color: '#f6f8fa', label: 'GitHub Light' },
  { color: '#fffbf0', label: 'Warm' },
  { color: '#f0f4f8', label: 'Cool Blue' },
  { color: '#f5f0eb', label: 'Solarized' },
];

const DEFAULT_DARK_BG = '#1e1e1e';
const DEFAULT_LIGHT_BG = '#ffffff';

// Shared chat header and status bar color presets
const CHAT_BAR_DARK_PRESETS = [
  { color: '#252526', label: 'Default' },
  { color: '#1e3a5f', label: 'Midnight Blue' },
  { color: '#263f36', label: 'Forest' },
  { color: '#3b3151', label: 'Purple' },
  { color: '#4a3428', label: 'Coffee' },
  { color: '#3f2b36', label: 'Rose' },
  { color: '#243b4a', label: 'Teal' },
  { color: '#3b3b3b', label: 'Graphite' },
];

const CHAT_BAR_LIGHT_PRESETS = [
  { color: '#f3f3f3', label: 'Default' },
  { color: '#e5f0fb', label: 'Sky' },
  { color: '#e5f2e9', label: 'Mint' },
  { color: '#eee8f7', label: 'Lavender' },
  { color: '#f6ebe3', label: 'Warm' },
  { color: '#f7e8ee', label: 'Rose' },
  { color: '#e4f1f3', label: 'Teal' },
  { color: '#e8e8e8', label: 'Graphite' },
];

const DEFAULT_DARK_CHAT_BAR = '#252526';
const DEFAULT_LIGHT_CHAT_BAR = '#f3f3f3';

// User message bubble color presets
const USER_MSG_DARK_PRESETS = [
  { color: '#005fb8', label: 'Default' },
  { color: '#1a7f37', label: 'Green' },
  { color: '#6e40c9', label: 'Purple' },
  { color: '#9a6700', label: 'Amber' },
  { color: '#cf222e', label: 'Red' },
  { color: '#0e6b8a', label: 'Teal' },
  { color: '#6b4c9a', label: 'Violet' },
  { color: '#4a5568', label: 'Gray' },
];

const USER_MSG_LIGHT_PRESETS = [
  { color: '#0078d4', label: 'Default' },
  { color: '#1a7f37', label: 'Green' },
  { color: '#8250df', label: 'Purple' },
  { color: '#bf8700', label: 'Amber' },
  { color: '#cf222e', label: 'Red' },
  { color: '#0e8a9a', label: 'Teal' },
  { color: '#7c5cbf', label: 'Violet' },
  { color: '#57606a', label: 'Gray' },
];

const DEFAULT_DARK_USER_MSG = '#005fb8';
const DEFAULT_LIGHT_USER_MSG = '#0078d4';

export interface AppearanceTabProps {
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  fontSizeLevel: number;
  onFontSizeLevelChange: (level: number) => void;
  editorFontConfig?: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
  };
  uiFontConfig?: UiFontConfig;
  codeFontConfig?: CodeFontConfig;
  onUiFontSelectionChange?: (selection: string) => void;
  onSaveUiFontCustomPath?: (path: string) => void;
  onBrowseUiFontFile?: () => void;
  onCodeFontSelectionChange?: (selection: string) => void;
  onSaveCodeFontCustomPath?: (path: string) => void;
  onBrowseCodeFontFile?: () => void;
  chatBgColor?: string;
  onChatBgColorChange?: (color: string) => void;
  userMsgColor?: string;
  onUserMsgColorChange?: (color: string) => void;
  chatBarColor?: string;
  onChatBarColorChange?: (color: string) => void;
  diffTheme?: DiffThemeMode;
  onDiffThemeChange?: (theme: DiffThemeMode) => void;
}

const AppearanceTab = ({
  theme,
  onThemeChange,
  fontSizeLevel,
  onFontSizeLevelChange,
  editorFontConfig,
  uiFontConfig,
  codeFontConfig,
  onUiFontSelectionChange = () => {},
  onSaveUiFontCustomPath = () => {},
  onBrowseUiFontFile = () => {},
  onCodeFontSelectionChange = () => {},
  onSaveCodeFontCustomPath = () => {},
  onBrowseCodeFontFile = () => {},
  chatBgColor = '',
  onChatBgColorChange = () => {},
  userMsgColor = '',
  onUserMsgColorChange = () => {},
  chatBarColor = '',
  onChatBarColorChange = () => {},
  diffTheme = 'follow',
  onDiffThemeChange = () => {},
}: AppearanceTabProps) => {
  const resolvedTheme = useMemo(() => {
    if (theme !== 'system') return theme;
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'dark';
  }, [theme]);

  return (
    <div className={styles.tabContent}>
      {/* Theme switcher */}
      <ThemeSection theme={theme} onThemeChange={onThemeChange} />

      {/* Language switcher */}
      <LanguageSection />

      {/* Font size selector */}
      <FontSizeSection fontSizeLevel={fontSizeLevel} onFontSizeLevelChange={onFontSizeLevelChange} />

      {/* UI font selector */}
      <UiFontSection
        uiFontConfig={uiFontConfig}
        editorFontConfig={editorFontConfig}
        onUiFontSelectionChange={onUiFontSelectionChange}
        onSaveUiFontCustomPath={onSaveUiFontCustomPath}
        onBrowseUiFontFile={onBrowseUiFontFile}
      />

      {/* Code font selector */}
      <CodeFontSection
        codeFontConfig={codeFontConfig}
        editorFontConfig={editorFontConfig}
        onCodeFontSelectionChange={onCodeFontSelectionChange}
        onSaveCodeFontCustomPath={onSaveCodeFontCustomPath}
        onBrowseCodeFontFile={onBrowseCodeFontFile}
      />

      {/* Diff theme */}
      <DiffThemeSection diffTheme={diffTheme} onDiffThemeChange={onDiffThemeChange} />

      {/* Chat background color */}
      <ColorSettingSection
        iconClassName="codicon codicon-paintcan"
        i18nPrefix="settings.basic.chatBgColor"
        resolvedTheme={resolvedTheme}
        darkPresets={DARK_PRESETS}
        lightPresets={LIGHT_PRESETS}
        darkDefault={DEFAULT_DARK_BG}
        lightDefault={DEFAULT_LIGHT_BG}
        color={chatBgColor}
        onColorChange={onChatBgColorChange}
      />

      {/* Shared chat header and status bar color */}
      <ColorSettingSection
        iconClassName="codicon codicon-layout"
        i18nPrefix="settings.basic.chatBarColor"
        resolvedTheme={resolvedTheme}
        darkPresets={CHAT_BAR_DARK_PRESETS}
        lightPresets={CHAT_BAR_LIGHT_PRESETS}
        darkDefault={DEFAULT_DARK_CHAT_BAR}
        lightDefault={DEFAULT_LIGHT_CHAT_BAR}
        color={chatBarColor}
        onColorChange={onChatBarColorChange}
      />

      {/* User message bubble color */}
      <ColorSettingSection
        iconClassName="codicon codicon-comment"
        i18nPrefix="settings.basic.userMsgColor"
        resolvedTheme={resolvedTheme}
        darkPresets={USER_MSG_DARK_PRESETS}
        lightPresets={USER_MSG_LIGHT_PRESETS}
        darkDefault={DEFAULT_DARK_USER_MSG}
        lightDefault={DEFAULT_LIGHT_USER_MSG}
        color={userMsgColor}
        onColorChange={onUserMsgColorChange}
      />
    </div>
  );
};

export default AppearanceTab;
