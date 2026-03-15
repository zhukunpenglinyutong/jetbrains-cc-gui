import { useState } from 'react';
import { isSoundEnabled, setSoundEnabled } from '../../../utils/soundNotification';
import styles from './style.module.less';

const SunIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
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
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

interface BasicConfigSectionProps {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
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
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  sendShortcut?: 'enter' | 'cmdEnter';
  onSendShortcutChange?: (shortcut: 'enter' | 'cmdEnter') => void;
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
  streamingEnabled = false,
  onStreamingEnabledChange = () => {},
  sendShortcut = 'enter',
  onSendShortcutChange = () => {},
}: BasicConfigSectionProps) => {
  const [soundEnabled, setSoundState] = useState(isSoundEnabled());

  const parseMajorVersion = (version: string | null | undefined): number => {
    if (!version) return 0;
    const versionStr = version.startsWith('v') ? version.substring(1) : version;
    const dotIndex = versionStr.indexOf('.');
    if (dotIndex > 0) {
      return parseInt(versionStr.substring(0, dotIndex), 10) || 0;
    }
    return parseInt(versionStr, 10) || 0;
  };

  const majorVersion = parseMajorVersion(nodeVersion);
  const isVersionTooLow = nodeVersion && majorVersion > 0 && majorVersion < minNodeVersion;

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>Basic Configuration</h3>
      <p className={styles.sectionDesc}>Configure page theme and Node.js environment</p>

      <div className={styles.themeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-symbol-color" />
          <span className={styles.fieldLabel}>Theme</span>
        </div>

        <div className={styles.themeGrid}>
          <div
            className={`${styles.themeCard} ${theme === 'light' ? styles.active : ''}`}
            onClick={() => onThemeChange('light')}
          >
            {theme === 'light' && (
              <div className={styles.checkBadge}>
                <span className="codicon codicon-check" />
              </div>
            )}

            <div className={styles.themeIconLight}>
              <SunIcon />
            </div>

            <div className={styles.themeCardTitle}>Light Theme</div>
            <div className={styles.themeCardDesc}>Fresh and bright, suitable for daytime use</div>
          </div>

          <div
            className={`${styles.themeCard} ${theme === 'dark' ? styles.active : ''}`}
            onClick={() => onThemeChange('dark')}
          >
            {theme === 'dark' && (
              <div className={styles.checkBadge}>
                <span className="codicon codicon-check" />
              </div>
            )}

            <div className={styles.themeIconDark}>
              <MoonIcon />
            </div>

            <div className={styles.themeCardTitle}>Dark Theme</div>
            <div className={styles.themeCardDesc}>Eye-friendly, suitable for nighttime use</div>
          </div>
        </div>
      </div>

      <div className={styles.fontSizeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-text-size" />
          <span className={styles.fieldLabel}>Font Size</span>
        </div>
        <select
          className={styles.fontSizeSelect}
          value={fontSizeLevel}
          onChange={(e) => onFontSizeLevelChange(Number(e.target.value))}
        >
          <option value={1}>Small (80%)</option>
          <option value={2}>Smaller (90%)</option>
          <option value={3}>Standard (100%)</option>
          <option value={4}>Larger (110%)</option>
          <option value={5}>Large (120%)</option>
          <option value={6}>Largest (140%)</option>
        </select>
      </div>

      <div className={styles.editorFontSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-symbol-text" />
          <span className={styles.fieldLabel}>Font (follows editor font)</span>
        </div>
        <div className={styles.fontInfoDisplay}>
          {editorFontConfig?.fontFamily || '-'}
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>Not editable here. To modify, go to IDEA Settings → Editor → Font (restart IDEA for plugin font to take effect)</span>
        </small>
      </div>

      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-terminal" />
          <span className={styles.fieldLabel}>Node.js Path</span>
          {nodeVersion && (
            <span className={`${styles.versionBadge} ${isVersionTooLow ? styles.versionBadgeError : styles.versionBadgeOk}`}>
              {nodeVersion}
            </span>
          )}
        </div>
        {isVersionTooLow && (
          <div className={styles.versionWarning}>
            <span className="codicon codicon-warning" />
            {`Node.js version is too low. The plugin requires v${minNodeVersion} or higher to run properly`}
          </div>
        )}
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder="e.g. C:\Program Files\nodejs\node.exe or /usr/local/bin/node"
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
            Save
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>
            Run in terminal <code>node -p "process.execPath"</code> to get the actual Node.js executable path. Leave empty to auto-detect.
          </span>
        </small>
      </div>

      <div className={styles.workingDirSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-folder" />
          <span className={styles.fieldLabel}>Working Directory</span>
        </div>
        <div className={styles.nodePathInputWrapper}>
          <input
            type="text"
            className={styles.nodePathInput}
            placeholder="e.g. project1 or leave empty to use project root"
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
            Save
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>
            Specify the directory where Claude works. Can use relative path (relative to project root) or absolute path. Leave empty to use project root.
          </span>
        </small>
      </div>

      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-sync" />
          <span className={styles.fieldLabel}>Streaming</span>
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
            {streamingEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>When enabled, AI responses will appear character by character in real-time, instead of waiting for the complete response. May consume more resources.</span>
        </small>
      </div>

      <div className={styles.streamingSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-unmute" />
          <span className={styles.fieldLabel}>Sound Notification</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={soundEnabled}
            onChange={(e) => {
              setSoundEnabled(e.target.checked);
              setSoundState(e.target.checked);
            }}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {soundEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>Play a sound when a task completes while the window is not focused.</span>
        </small>
      </div>

      <div className={styles.sendShortcutSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-keyboard" />
          <span className={styles.fieldLabel}>Send Shortcut</span>
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
            <div className={styles.themeCardTitle}>Enter to Send</div>
            <div className={styles.themeCardDesc}>Press Enter to send message, Shift+Enter for new line</div>
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
            <div className={styles.themeCardTitle}>⌘/Ctrl+Enter to Send</div>
            <div className={styles.themeCardDesc}>Press ⌘/Ctrl+Enter to send message, Enter for new line</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BasicConfigSection;
