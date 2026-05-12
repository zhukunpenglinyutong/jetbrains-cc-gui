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
import ko from './locales/ko.json';
import ptBR from './locales/pt-BR.json';

export const SUPPORTED_UI_LANGUAGES = ['zh', 'en', 'zh-TW', 'hi', 'es', 'fr', 'ja', 'ru', 'ko', 'pt-BR'] as const;

export const normalizeUiLanguage = (language?: string | null): string => {
  if (!language) return 'en';
  return (SUPPORTED_UI_LANGUAGES as readonly string[]).includes(language) ? language : 'en';
};

// Retrieve the saved language from localStorage; default to English if not set
const getInitialLanguage = (): string => {
  const savedLanguage = localStorage.getItem('language');
  return normalizeUiLanguage(savedLanguage); // Default to English
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
      ko: { translation: ko }, // Korean
      'pt-BR': { translation: ptBR }, // Portuguese (Brazil)
    },
    lng: getInitialLanguage(), // Initial language
    fallbackLng: 'en', // Fallback to English when a translation is missing
    interpolation: {
      escapeValue: false, // React already handles XSS protection
    },
  });

export default i18n;
