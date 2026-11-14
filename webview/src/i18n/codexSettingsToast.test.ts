import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import ptBR from './locales/pt-BR.json';
import ru from './locales/ru.json';
import zhTW from './locales/zh-TW.json';
import zh from './locales/zh.json';

describe('Codex settings dispatch failure translations', () => {
  it.each([
    ['en', en, /Cannot send/u],
    ['es', es, /configuración/u],
    ['fr', fr, /paramètres/u],
    ['hi', hi, /\p{Script=Devanagari}/u],
    ['ja', ja, /\p{Script=Hiragana}/u],
    ['ko', ko, /\p{Script=Hangul}/u],
    ['pt-BR', ptBR, /configurações/u],
    ['ru', ru, /\p{Script=Cyrillic}/u],
    ['zh-TW', zhTW, /無法將/u],
    ['zh', zh, /无法将/u],
  ] as const)('preserves readable UTF-8 content in %s', (_locale, messages, language) => {
    const text = messages.toast.codexSettingsDispatchFailed;
    expect(text).toContain('Codex');
    expect(text).toContain('IDE');
    expect(text).not.toMatch(/[?\uFFFD]/u);
    expect(text).toMatch(language);
  });

  it.each([en, es, fr, hi, ja, ko, ptBR, ru, zhTW, zh])('provides readable translations for known backend failures', messages => {
    for (const key of ['codexSettingsRuntimeInactive', 'codexSettingsServiceUnavailable', 'codexSettingsUpdateFailed'] as const) {
      const text = messages.toast[key];
      expect(text).toContain('Codex');
      expect(text).not.toMatch(/[?\uFFFD]/u);
      expect(text.length).toBeGreaterThan(20);
    }
  });
});
