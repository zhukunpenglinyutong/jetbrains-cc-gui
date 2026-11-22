import { createInstance } from 'i18next';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import ru from './locales/ru.json';
import ptBR from './locales/pt-BR.json';
import zh from './locales/zh.json';
import zhTW from './locales/zh-TW.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';

const translations = { en, es, fr, hi, ru, 'pt-BR': ptBR, zh, 'zh-TW': zhTW, ja, ko };

const createI18n = async (lng: string) => {
  const i18n = createInstance();
  await i18n.init({
    resources: Object.fromEntries(Object.entries(translations).map(([language, translation]) =>
      [language, { translation }])),
    lng,
    fallbackLng: 'en',
  });
  return i18n;
};

const flatten = (node: unknown, prefix = ''): Record<string, string> =>
  Object.entries(node as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => (
    typeof value === 'object' && value !== null
      ? { ...acc, ...flatten(value, `${prefix}${key}.`) }
      : { ...acc, [`${prefix}${key}`]: String(value) }
  ), {});

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

describe('time-ago labels', () => {
  it.each([
    ['ru', 'дн. назад'], ['zh', '天前'], ['ja', '日前'],
  ])('history list labels are localized for %s (called without count)', async (lng, expected) => {
    const i18n = await createI18n(lng);
    expect(i18n.t('history.timeAgo.daysAgo')).toBe(expected);
  });

  it.each([
    ['ru', 3, '3 дня назад'], ['zh', 3, '3天前'], ['zh-TW', 1, '1天前'], ['ja', 2, '2日前'],
  ])('settings labels are localized for %s with count %s', async (lng, count, expected) => {
    const i18n = await createI18n(lng);
    expect(i18n.t('settings.other.historyCompletion.timeAgo.daysAgo', { count })).toBe(expected);
  });
});

describe('locale plural keys', () => {
  // i18next resolves `key_other` before `key`, so an English plural copy hides a translated base key.
  it.each(Object.entries(translations).filter(([lng]) => lng !== 'en'))(
    '%s has no untranslated English plural form shadowing a translated base key',
    (_lng, translation) => {
      const enFlat = flatten(en);
      const flat = flatten(translation);
      const shadowing = Object.keys(flat).filter((key) => {
        const base = key.replace(PLURAL_SUFFIX, '');
        return base !== key && base in flat && flat[base] !== enFlat[base] && flat[key] === enFlat[key];
      });
      expect(shadowing).toEqual([]);
    },
  );
});
