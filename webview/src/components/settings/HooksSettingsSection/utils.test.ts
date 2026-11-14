import { describe, expect, it } from 'vitest';
import en from '../../../i18n/locales/en.json';
import es from '../../../i18n/locales/es.json';
import fr from '../../../i18n/locales/fr.json';
import hi from '../../../i18n/locales/hi.json';
import ja from '../../../i18n/locales/ja.json';
import ko from '../../../i18n/locales/ko.json';
import ptBR from '../../../i18n/locales/pt-BR.json';
import ru from '../../../i18n/locales/ru.json';
import zh from '../../../i18n/locales/zh.json';
import zhTW from '../../../i18n/locales/zh-TW.json';
import { hookOperationMessage } from './utils';

function translator(messages: Record<string, unknown>) {
  return (key: string) => {
    const value = key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      messages,
    );
    return typeof value === 'string' ? value : key;
  };
}

describe('hookOperationMessage', () => {
  const t = translator(en);

  it('translates backend error codes instead of showing them raw', () => {
    expect(hookOperationMessage('HOOK_REVISION_CONFLICT', t)).toBe(en.settings.hooks.errors.HOOK_REVISION_CONFLICT);
    expect(hookOperationMessage('INVALID_JSON', t)).toBe(en.settings.hooks.issues.INVALID_JSON);
    expect(hookOperationMessage('SOMETHING_NEW', t)).toBe('SOMETHING_NEW');
  });

  it('keeps the same error keys in every locale', () => {
    const expected = Object.keys(en.settings.hooks.errors).sort();
    for (const locale of [es, fr, hi, ja, ko, ptBR, ru, zh, zhTW]) {
      expect(Object.keys(locale.settings.hooks.errors).sort()).toEqual(expected);
    }
  });
});
