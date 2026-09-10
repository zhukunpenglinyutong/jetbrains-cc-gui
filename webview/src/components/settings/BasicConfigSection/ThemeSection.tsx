import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

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

interface ThemeSectionProps {
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
}

const ThemeSection = ({ theme, onThemeChange }: ThemeSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.themeSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-symbol-color" />
        <span className={styles.fieldLabel}>{t('settings.basic.theme.label')}</span>
      </div>

      <div className={styles.themeSelector}>
        <div
          className={`${styles.themeOption} ${theme === 'system' ? styles.active : ''}`}
          onClick={() => onThemeChange('system')}
        >
          <div className={styles.themeIconSystem}>
            <SystemIcon />
          </div>
          <span className={styles.themeOptionLabel}>{t('settings.basic.theme.system')}</span>
        </div>

        <div
          className={`${styles.themeOption} ${theme === 'light' ? styles.active : ''}`}
          onClick={() => onThemeChange('light')}
        >
          <div className={styles.themeIconLight}>
            <SunIcon />
          </div>
          <span className={styles.themeOptionLabel}>{t('settings.basic.theme.light')}</span>
        </div>

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
  );
};

export default ThemeSection;
