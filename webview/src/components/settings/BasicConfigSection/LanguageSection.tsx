import { useState, useEffect } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

const FOLLOW_IDEA_LANGUAGE = '__follow_idea__';

const LANGUAGE_OPTIONS = [
  { value: FOLLOW_IDEA_LANGUAGE, label: 'settings.basic.language.followIde' },
  { value: 'zh', label: 'settings.basic.language.simplifiedChinese' },
  { value: 'zh-TW', label: 'settings.basic.language.traditionalChinese' },
  { value: 'en', label: 'settings.basic.language.english' },
  { value: 'hi', label: 'settings.basic.language.hindi' },
  { value: 'es', label: 'settings.basic.language.spanish' },
  { value: 'fr', label: 'settings.basic.language.french' },
  { value: 'ja', label: 'settings.basic.language.japanese' },
  { value: 'ru', label: 'settings.basic.language.russian' },
  { value: 'ko', label: 'settings.basic.language.korean' },
  { value: 'pt-BR', label: 'settings.basic.language.portuguese' },
];

const LanguageSection = () => {
  const { t, i18n } = useTranslation();
  const [languageSelection, setLanguageSelection] = useState(() => (
    localStorage.getItem('languageSelectionMode') === 'followIdea'
      ? FOLLOW_IDEA_LANGUAGE
      : (i18n.language || 'zh')
  ));

  useEffect(() => {
    const resync = () => {
      setLanguageSelection(
        localStorage.getItem('languageSelectionMode') === 'followIdea'
          ? FOLLOW_IDEA_LANGUAGE
          : (i18n.language || 'zh')
      );
    };
    resync();
    window.addEventListener('language-config-applied', resync);
    return () => window.removeEventListener('language-config-applied', resync);
  }, [i18n.language]);

  const languageOptions = LANGUAGE_OPTIONS;

  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const language = event.target.value;
    // Optimistic UI update. Java owns the persisted config and pushes the
    // authoritative state back via applyIdeaLanguageConfig, which is the
    // single writer for localStorage language keys.
    setLanguageSelection(language);

    if (language === FOLLOW_IDEA_LANGUAGE) {
      if (window.sendToJava) {
        window.sendToJava('clear_user_language:');
      }
      return;
    }

    i18n.changeLanguage(language);
    if (window.sendToJava) {
      window.sendToJava(`set_user_language:${JSON.stringify({ language })}`);
    }
  };

  return (
    <div className={styles.languageSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-globe" />
        <span className={styles.fieldLabel}>{t('settings.basic.language.label')}</span>
      </div>
      <select
        className={styles.languageSelect}
        value={languageSelection}
        onChange={handleLanguageChange}
      >
        {languageOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </select>
    </div>
  );
};

export default LanguageSection;
