import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './locales/zh.json';
import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';
import hi from './locales/hi.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ja from './locales/ja.json';
import ru from './locales/ru.json';

// Retrieve the saved language from localStorage; default to English if not set
const getInitialLanguage = (): string => {
  const savedLanguage = localStorage.getItem('language');
  return savedLanguage || 'en'; // Default to English
};

i18n
  .use(initReactI18next) // Integrate i18n with React
  .init({
    resources: {
      zh: { translation: zh }, // Simplified Chinese
      en: { translation: en }, // English
      'zh-TW': { translation: zhTW }, // Traditional Chinese
      hi: { translation: hi }, // Hindi
      es: { translation: es }, // Spanish
      fr: { translation: fr }, // French
      ja: { translation: ja }, // Japanese
      ru: { translation: ru }, // Russian
    },
    lng: getInitialLanguage(), // Initial language
    fallbackLng: 'en', // Fallback to English when a translation is missing
    interpolation: {
      escapeValue: false, // React already handles XSS protection
    },
  });

export default i18n;
