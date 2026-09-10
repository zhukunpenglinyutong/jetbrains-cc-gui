import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import type { DiffThemeMode } from '../../../utils/diffTheme';

interface DiffThemeSectionProps {
  diffTheme: DiffThemeMode;
  onDiffThemeChange: (theme: DiffThemeMode) => void;
}

const DiffThemeSection = ({ diffTheme, onDiffThemeChange }: DiffThemeSectionProps) => {
  const { t } = useTranslation();

  const diffThemeOptions: Array<{ value: DiffThemeMode; label: string; desc: string }> = [
    {
      value: 'follow',
      label: t('settings.basic.diffTheme.follow'),
      desc: t('settings.basic.diffTheme.followDesc'),
    },
    {
      value: 'editor',
      label: t('settings.basic.diffTheme.editor'),
      desc: t('settings.basic.diffTheme.editorDesc'),
    },
    {
      value: 'light',
      label: t('settings.basic.diffTheme.light'),
      desc: t('settings.basic.diffTheme.lightDesc'),
    },
    {
      value: 'soft-dark',
      label: t('settings.basic.diffTheme.softDark'),
      desc: t('settings.basic.diffTheme.softDarkDesc'),
    },
  ];

  return (
    <div className={styles.themeSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-diff" />
        <span className={styles.fieldLabel}>{t('settings.basic.diffTheme.label')}</span>
      </div>

      <select
        className={styles.languageSelect}
        value={diffTheme}
        onChange={(e) => onDiffThemeChange(e.target.value as DiffThemeMode)}
      >
        {diffThemeOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label} — {option.desc}
          </option>
        ))}
      </select>
    </div>
  );
};

export default DiffThemeSection;
