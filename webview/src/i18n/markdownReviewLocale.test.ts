import { describe, expect, it } from 'vitest';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import ptBR from './locales/pt-BR.json';
import ru from './locales/ru.json';
import zhTW from './locales/zh-TW.json';
import zh from './locales/zh.json';
import en from './locales/en.json';

const locales: Record<string, unknown> = { en, zh, 'zh-TW': zhTW, ja, ko, fr, es, ru, 'pt-BR': ptBR, hi };

/** Logical key = path without an i18next plural suffix; any plural form satisfies it. */
function logicalKeys(namespace: unknown, prefix = ''): Set<string> {
  const keys = new Set<string>();
  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      keys.add(path.replace(/_(zero|one|two|few|many|other)$/, ''));
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
  };
  walk(namespace, prefix);
  return keys;
}

describe('markdownReview locale completeness', () => {
  // Scoped to this feature's namespace: other namespaces carry pre-existing gaps
  // that are out of scope for the Markdown review hardening branch.
  const expected = [...logicalKeys(en.markdownReview)].sort();

  it('keeps the English namespace non-trivial', () => {
    expect(expected.length).toBeGreaterThanOrEqual(30);
  });

  for (const [language, bundle] of Object.entries(locales)) {
    it(`covers every Markdown review key in ${language}`, () => {
      const actual = logicalKeys((bundle as { markdownReview?: unknown }).markdownReview);
      expect([...actual].sort()).toEqual(expected);
    });
  }
});
