import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './locales/zh.json';
import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';
import hi from './locales/hi.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ja from './locales/ja.json';

// 从 localStorage 获取保存的语言设置，如果没有则默认为英文
const getInitialLanguage = (): string => {
  const savedLanguage = localStorage.getItem('language');
  return savedLanguage || 'en'; // 默认英文
};

i18n
  .use(initReactI18next) // 让 i18n 和 React 一起工作
  .init({
    resources: {
      zh: { translation: zh }, // 简体中文翻译资源
      en: { translation: en }, // 英文翻译资源
      'zh-TW': { translation: zhTW }, // 繁体中文翻译资源
      hi: { translation: hi }, // 印地语翻译资源
      es: { translation: es }, // 西班牙语翻译资源
      fr: { translation: fr }, // 法语翻译资源
      ja: { translation: ja }, // 日语翻译资源
    },
    lng: getInitialLanguage(), // 默认语言
    fallbackLng: 'en', // 如果翻译缺失，回退到英文
    interpolation: {
      escapeValue: false, // React 已经自动处理 XSS 防护
    },
  });

export default i18n;
