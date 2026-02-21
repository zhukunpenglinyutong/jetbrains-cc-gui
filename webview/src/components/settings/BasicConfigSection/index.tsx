import { useState, useRef, useEffect, useMemo } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

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

const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 17C14.7614 17 17 14.7614 17 12C17 9.23858 14.7614 7 12 7C9.23858 7 7 9.23858 7 12C7 14.7614 9.23858 17 12 17Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M12 1V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M12 21V23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4.22 4.22L5.64 5.64" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M18.36 18.36L19.78 19.78" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M1 12H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M21 12H23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4.22 19.78L5.64 18.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M18.36 5.64L19.78 4.22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const MoonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const SystemIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/>
    <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

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
  // Diff expanded by default configuration
  diffExpandedByDefault?: boolean;
  onDiffExpandedByDefaultChange?: (enabled: boolean) => void;
}

const BasicConfigSection = ({
  theme,
  onThemeChange,
  fontSizeLevel,
  onFontSizeLevelChange,
  nodePath,
  onNodePathChange,
  onSaveNodePath,
  savingNodePath,
  nodeVersion,
  minNodeVersion = 18,
  workingDirectory = '',
  onWorkingDirectoryChange = () => {},
  onSaveWorkingDirectory = () => {},
  savingWorkingDirectory = false,
  editorFontConfig,
  // Streaming configuration
  streamingEnabled = true,
  onStreamingEnabledChange = () => {},
  // Auto open file configuration
  autoOpenFileEnabled = true,
  onAutoOpenFileEnabledChange = () => {},
  // Send shortcut configuration
  sendShortcut = 'enter',
  onSendShortcutChange = () => {},
  // Chat background color configuration
  chatBgColor = '',
  onChatBgColorChange = () => {},
  // Diff expanded by default configuration
  diffExpandedByDefault = false,
  onDiffExpandedByDefaultChange = () => {},
}: BasicConfigSectionProps) => {
  const { t, i18n } = useTranslation();
  const colorInputRef = useRef<HTMLInputElement>(null);
  const [hexInput, setHexInput] = useState(chatBgColor || '');

  // H1 fix: sync hexInput when chatBgColor prop changes
  useEffect(() => {
    setHexInput(chatBgColor || '');
  }, [chatBgColor]);

  // L1 fix: use useMemo + data-theme attribute cache to avoid direct DOM reads during render
  const resolvedTheme = useMemo(() => {
    if (theme !== 'system') return theme;
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'dark';
  }, [theme]);

  // M4 fix: extract default background color constants
  const defaultBgColor = resolvedTheme === 'light' ? DEFAULT_LIGHT_BG : DEFAULT_DARK_BG;
  const presets = resolvedTheme === 'light' ? LIGHT_PRESETS : DARK_PRESETS;

  const handlePresetClick = (color: string) => {
    if (color === defaultBgColor) {
      onChatBgColorChange('');
    } else {
      onChatBgColorChange(color);
    }
  };

  const handleColorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChatBgColorChange(e.target.value);
  };

  const handleHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setHexInput(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      onChatBgColorChange(value);
    }
  };

  const handleResetBgColor = () => {
    onChatBgColorChange('');
  };

  const isPresetActive = (presetColor: string) => {
    if (presetColor === defaultBgColor && !chatBgColor) return true;
    return chatBgColor.toLowerCase() === presetColor.toLowerCase();
  };

  // Parse the major version number
  const parseMajorVersion = (version: string | null | undefined): number => {
    if (!version) return 0;
    const versionStr = version.startsWith('v') ? version.substring(1) : version;
    const dotIndex = versionStr.indexOf('.');
    if (dotIndex > 0) {
      return parseInt(versionStr.substring(0, dotIndex), 10) || 0;
    }
    return parseInt(versionStr, 10) || 0;
  };

  // Check if the version is too low
  const majorVersion = parseMajorVersion(nodeVersion);
  const isVersionTooLow = nodeVersion && majorVersion > 0 && majorVersion < minNodeVersion;

  // Current language
  const currentLanguage = i18n.language || 'zh';

  // Language options
  const languageOptions = [
    { value: 'zh', label: 'settings.basic.language.simplifiedChinese' },
    { value: 'zh-TW', label: 'settings.basic.language.traditionalChinese' },
    { value: 'en', label: 'settings.basic.language.english' },
    { value: 'hi', label: 'settings.basic.language.hindi' },
    { value: 'es', label: 'settings.basic.language.spanish' },
    { value: 'fr', label: 'settings.basic.language.french' },
    { value: 'ja', label: 'settings.basic.language.japanese' },
    { value: 'ru', label: 'settings.basic.language.russian' },
  ];

  // Switch language
  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const language = event.target.value;
    i18n.changeLanguage(language);
    localStorage.setItem('language', language);
    // Mark that user has manually set the language, so IDEA language won't override it
    localStorage.setItem('languageManuallySet', 'true');
  };

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.basic.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.basic.description')}</p>

      {/* Theme switcher */}
      <div className={styles.themeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-symbol-color" />
          <span className={styles.fieldLabel}>{t('settings.basic.theme.label')}</span>
        </div>

        <div className={styles.themeSelector}>
          {/* Follow IDE */}
          <div
            className={`${styles.themeOption} ${theme === 'system' ? styles.active : ''}`}
            onClick={() => onThemeChange('system')}
          >
            <div className={styles.themeIconSystem}>
              <SystemIcon />
            </div>
            <span className={styles.themeOptionLabel}>{t('settings.basic.theme.system')}</span>
          </div>

          {/* Light theme */}
          <div
            className={`${styles.themeOption} ${theme === 'light' ? styles.active : ''}`}
            onClick={() => onThemeChange('light')}
          >
            <div className={styles.themeIconLight}>
              <SunIcon />
            </div>
            <span className={styles.themeOptionLabel}>{t('settings.basic.theme.light')}</span>
          </div>

          {/* Dark theme */}
          <div
            className={`${styles.themeOption} ${theme === 'dark' ? styles.active : ''}`}
            onClick={() => onThemeChange('dark')}
          >
            <div className={styles.themeIconDark}>
              <MoonIcon />
            </div>
            <span className={styles.themeOptionLabel}>{t('settings.basic.theme.dark')}</span>
          </div>
        </div>
      </div>

      {/* Chat background color */}
      <div className={styles.bgColorSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-paintcan" />
          <span className={styles.fieldLabel}>{t('settings.basic.chatBgColor.label')}</span>
        </div>

        {/* Preset colors */}
        <div className={styles.colorPresets}>
          {presets.map((preset) => (
            <div
              key={preset.color}
              className={`${styles.colorSwatch} ${isPresetActive(preset.color) ? styles.active : ''}`}
              onClick={() => handlePresetClick(preset.color)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handlePresetClick(preset.color);
                }
              }}
              role="button"
              tabIndex={0}
              title={preset.label}
              aria-label={preset.label}
            >
              <div
                className={styles.colorSwatchInner}
                style={{ backgroundColor: preset.color }}
              />
            </div>
          ))}
        </div>

        {/* Custom color */}
        <div className={styles.customColorRow}>
          <span className={styles.customColorLabel}>{t('settings.basic.chatBgColor.custom')}</span>
          <div
            className={styles.colorPickerWrapper}
            onClick={() => colorInputRef.current?.click()}
          >
            <div
              className={styles.colorPickerPreview}
              style={{ backgroundColor: chatBgColor || defaultBgColor }}
            />
            <input
              ref={colorInputRef}
              type="color"
              className={styles.colorPickerInput}
              value={chatBgColor || defaultBgColor}
              onChange={handleColorInputChange}
            />
          </div>
          <input
            type="text"
            className={styles.hexInput}
            value={hexInput}
            onChange={handleHexInputChange}
            placeholder="#000000"
            maxLength={7}
          />
          {chatBgColor && (
            <button
              className={styles.resetBtn}
              onClick={handleResetBgColor}
              title={t('settings.basic.chatBgColor.reset')}
            >
              <span className="codicon codicon-discard" />
              {t('settings.basic.chatBgColor.reset')}
            </button>
          )}
        </div>

        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.chatBgColor.hint')}</span>
        </small>
      </div>

      {/* Language switcher */}
      <div className={styles.languageSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-globe" />
          <span className={styles.fieldLabel}>{t('settings.basic.language.label')}</span>
        </div>
        <select
          className={styles.languageSelect}
          value={currentLanguage}
          onChange={handleLanguageChange}
        >
          {languageOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </div>

      {/* Font size selector */}
      <div className={styles.fontSizeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-text-size" />
          <span className={styles.fieldLabel}>{t('settings.basic.fontSize.label')}</span>
        </div>
        <select
          className={styles.fontSizeSelect}
          value={fontSizeLevel}
          onChange={(e) => onFontSizeLevelChange(Number(e.target.value))}
        >
          <option value={1}>{t('settings.basic.fontSize.level1')}</option>
          <option value={2}>{t('settings.basic.fontSize.level2')}</option>
          <option value={3}>{t('settings.basic.fontSize.level3')}</option>
          <option value={4}>{t('settings.basic.fontSize.level4')}</option>
          <option value={5}>{t('settings.basic.fontSize.level5')}</option>
          <option value={6}>{t('settings.basic.fontSize.level6')}</option>
        </select>
      </div>

      {/* IDEA editor font display - read only */}
      <div className={styles.editorFontSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-symbol-text" />
          <span className={styles.fieldLabel}>{t('settings.basic.editorFont.label')}</span>
        </div>
        <div className={styles.fontInfoDisplay}>
          {editorFontConfig?.fontFamily || '-'}
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.editorFont.hint')}</span>
        </small>
      </div>

      {/* Node.js path configuration */}
      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-terminal" />
          <span className={styles.fieldLabel}>{t('settings.basic.nodePath.label')}</span>
          {nodeVersion && (
            <span className={`${styles.versionBadge} ${isVersionTooLow ? styles.versionBadgeError : styles.versionBadgeOk}`}>
              {nodeVersion}
            </span>
          )}
        </div>
        {isVersionTooLow && (
          <div className={styles.versionWarning}>
            <span className="codicon codicon-warning" />
            {t('settings.basic.nodePath.versionTooLow', { minVersion: minNodeVersion })}
          </div>
        )}
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.nodePath.placeholder')}
            value={nodePath}
            onChange={(e) => onNodePathChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveNodePath}
            disabled={savingNodePath}
          >
            {savingNodePath && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>
            {t('settings.basic.nodePath.hint')} <code>{t('settings.basic.nodePath.hintCommand')}</code> {t('settings.basic.nodePath.hintText')}
          </span>
        </small>
      </div>

      {/* Working directory configuration */}
      <div className={styles.workingDirSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-folder" />
          <span className={styles.fieldLabel}>{t('settings.basic.workingDirectory.label')}</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder={t('settings.basic.workingDirectory.placeholder')}
            value={workingDirectory}
            onChange={(e) => onWorkingDirectoryChange(e.target.value)}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveWorkingDirectory}
            disabled={savingWorkingDirectory}
          >
            {savingWorkingDirectory && (
              <span
                className="codicon codicon-loading codicon-modifier-spin"
              />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>
            {t('settings.basic.workingDirectory.hint')}
          </span>
        </small>
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

      {/* Send shortcut configuration */}
      <div className={styles.sendShortcutSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-keyboard" />
          <span className={styles.fieldLabel}>{t('settings.basic.sendShortcut.label')}</span>
        </div>
        <div className={styles.themeGrid}>
          {/* Send with Enter */}
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

          {/* Send with Cmd/Ctrl+Enter */}
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
    </div>
  );
};

export default BasicConfigSection;
