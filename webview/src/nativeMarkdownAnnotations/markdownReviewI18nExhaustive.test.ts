import { describe, it, expect } from 'vitest';
import { labelTranslations, previewLabels } from './labels';

describe('Exhaustive 10-language internationalization coverage', () => {
  const supportedLanguages = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pt-BR', 'ru', 'hi'];
  const baseKeys = Object.keys(labelTranslations.en).sort();

  it('provides translations for all 10 supported languages without missing any keys', () => {
    for (const lang of supportedLanguages) {
      const translation = labelTranslations[lang];
      expect(translation, `Missing translation bundle for language "${lang}"`).toBeDefined();
      const currentKeys = Object.keys(translation).sort();
      expect(currentKeys, `Language "${lang}" does not match English key set`).toEqual(baseKeys);

      // Verify no empty or whitespace-only translation strings
      for (const key of baseKeys) {
        const val = (translation as any)[key];
        expect(typeof val, `Key "${key}" in "${lang}" must be string`).toBe('string');
        expect(val.trim().length, `Key "${key}" in "${lang}" cannot be empty`).toBeGreaterThan(0);
      }
    }
  });

  it('correctly translates core action buttons and bridge error keys in all languages', () => {
    const criticalKeys = [
      'transfer', 'transferOne', 'complete', 'reopen', 'comment', 'quote',
      'save', 'cancel', 'edit', 'remove', 'disabled', 'chatGone', 'chatUnavailable',
      'timeout', 'selectionMismatch', 'missing', 'pending',
    ];

    for (const lang of supportedLanguages) {
      const dict = labelTranslations[lang];
      for (const key of criticalKeys) {
        expect((dict as any)[key]).toBeTruthy();
      }
    }
  });

  it('falls back gracefully to English for unknown locales', () => {
    const fallbackDe = previewLabels('de-DE');
    expect(fallbackDe.title).toBe(labelTranslations.en.title);

    const fallbackIt = previewLabels('it');
    expect(fallbackIt.complete).toBe(labelTranslations.en.complete);

    // Prefix matching for variants (e.g. zh-CN -> zh, en-US -> en)
    const zhCn = previewLabels('zh-CN');
    expect(zhCn.complete).toBe(labelTranslations.zh.complete);

    const enUs = previewLabels('en-US');
    expect(enUs.complete).toBe(labelTranslations.en.complete);
  });
});
