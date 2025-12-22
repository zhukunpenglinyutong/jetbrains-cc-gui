import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

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
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  onSaveWorkingDirectory?: () => void;
  savingWorkingDirectory?: boolean;
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
  workingDirectory = '',
  onWorkingDirectoryChange = () => {},
  onSaveWorkingDirectory = () => {},
  savingWorkingDirectory = false,
}: BasicConfigSectionProps) => {
  const { t, i18n } = useTranslation();

  // 当前语言
  const currentLanguage = i18n.language || 'zh';

  // 语言选项
  const languageOptions = [
    { value: 'zh', label: 'settings.basic.language.simplifiedChinese' },
    { value: 'zh-TW', label: 'settings.basic.language.traditionalChinese' },
    { value: 'en', label: 'settings.basic.language.english' },
    { value: 'hi', label: 'settings.basic.language.hindi' },
    { value: 'es', label: 'settings.basic.language.spanish' },
    { value: 'fr', label: 'settings.basic.language.french' },
  ];

  // 切换语言
  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const language = event.target.value;
    i18n.changeLanguage(language);
    localStorage.setItem('language', language);
  };

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.basic.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.basic.description')}</p>

      {/* 主题切换 */}
      <div className={styles.themeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-symbol-color" />
          <span className={styles.fieldLabel}>{t('settings.basic.theme.label')}</span>
        </div>

        <div className={styles.themeGrid}>
          {/* 亮色主题卡片 */}
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

            <div className={styles.themeCardTitle}>{t('settings.basic.theme.light')}</div>
            <div className={styles.themeCardDesc}>{t('settings.basic.theme.lightDesc')}</div>
          </div>

          {/* 暗色主题卡片 */}
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

            <div className={styles.themeCardTitle}>{t('settings.basic.theme.dark')}</div>
            <div className={styles.themeCardDesc}>{t('settings.basic.theme.darkDesc')}</div>
          </div>
        </div>
      </div>

      {/* 语言切换 */}
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

      {/* 字体大小选择 */}
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
        </select>
      </div>

      {/* Node.js 路径配置 */}
      <div className={styles.nodePathSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-terminal" />
          <span className={styles.fieldLabel}>{t('settings.basic.nodePath.label')}</span>
        </div>
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

      {/* 工作目录配置 */}
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
    </div>
  );
};

export default BasicConfigSection;
