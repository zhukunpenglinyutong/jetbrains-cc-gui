import { describe, expect, it } from 'vitest';
import { createLocalizeMessage } from './localizationUtils';
import zh from '../i18n/locales/zh.json';
import en from '../i18n/locales/en.json';
import zhTW from '../i18n/locales/zh-TW.json';
import hi from '../i18n/locales/hi.json';
import es from '../i18n/locales/es.json';
import fr from '../i18n/locales/fr.json';
import ja from '../i18n/locales/ja.json';
import ru from '../i18n/locales/ru.json';
import ko from '../i18n/locales/ko.json';
import ptBR from '../i18n/locales/pt-BR.json';

const locales = {
  zh,
  en,
  'zh-TW': zhTW,
  hi,
  es,
  fr,
  ja,
  ru,
  ko,
  'pt-BR': ptBR,
};

describe('createLocalizeMessage', () => {
  it('localizes unsupported image vision placeholder while preserving details', () => {
    const t = ((key: string) => {
      const translations: Record<string, string> = {
        'aiBridge.unsupportedImageVision': '当前模型不支持图片识别，或该服务商兼容接口不支持图片工具结果。\n请切换到支持视觉的模型后重试。',
      };
      return translations[key] ?? key;
    }) as any;

    const localize = createLocalizeMessage(t);
    const result = localize('__I18N__:aiBridge.unsupportedImageVision\n\nDetails:\nraw backend detail');

    expect(result).toContain('当前模型不支持图片识别');
    expect(result).toContain('请切换到支持视觉的模型后重试');
    expect(result).toContain('raw backend detail');
  });

  it('defines unsupported image vision translation for every registered locale', () => {
    for (const [language, locale] of Object.entries(locales)) {
      expect(locale.aiBridge.unsupportedImageVision, language).toEqual(expect.any(String));
      expect(locale.aiBridge.unsupportedImageVision.trim(), language).not.toBe('');
    }
  });
});
