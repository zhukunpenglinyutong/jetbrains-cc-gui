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

describe('workspace diff file counts', () => {
  it.each([
    ['en', 1, '1 file'], ['en', 5, '5 files'],
    ['es', 1, '1 archivo'], ['es', 5, '5 archivos'],
    ['fr', 1, '1 fichier'], ['fr', 5, '5 fichiers'],
    ['hi', 1, '1 फ़ाइल'], ['hi', 5, '5 फ़ाइलें'],
    ['ru', 1, '1 файл'], ['ru', 2, '2 файла'], ['ru', 5, '5 файлов'],
    ['ru', 21, '21 файл'], ['ru', 22, '22 файла'],
    ['pt-BR', 1, '1 arquivo'], ['pt-BR', 5, '5 arquivos'],
    ['zh', 1, '1 个文件'], ['zh-TW', 2, '2 個檔案'],
    ['ja', 1, '1 件のファイル'], ['ko', 2, '2개 파일'],
  ])('renders %s with count %s as %s', async (lng, count, expected) => {
    const i18n = createInstance();
    await i18n.init({
      resources: Object.fromEntries(Object.entries(translations).map(([language, translation]) =>
        [language, { translation }])),
      lng: String(lng),
      fallbackLng: 'en',
    });

    expect(i18n.t('workspaceDiff.fileCount', { count: Number(count) })).toBe(expected);
  });
});
