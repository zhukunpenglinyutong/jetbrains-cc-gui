import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Locale parity guard.
 *
 * The "auto-convert sessions on exit" feature shipped its keys to every locale
 * except en/zh/zh-TW, so English and Chinese users saw raw key names such as
 * `settings.basic.autoConvertSessionsOnExit.label` instead of text (i18next
 * `fallbackLng: 'en'` can only help when the fallback locale itself has the key).
 * This test fails as soon as a locale misses a key that en.json defines, so the
 * same gap cannot silently reappear in the next feature.
 */

const LOCALES_DIR = join(__dirname, 'locales');
const REFERENCE_LOCALE = 'en';

/** Only these subtrees are user-visible enough to be worth a hard parity gate. */
const PARITY_SECTIONS = ['settings.basic', 'history'] as const;

/** Keys that the feature under test introduced — listed explicitly so a regression
 * reports the feature name, not just a list of 20 unrelated key paths. */
const FEATURE_KEYS = [
  'settings.basic.autoConvertSessionsOnExit.label',
  'settings.basic.autoConvertSessionsOnExit.enabled',
  'settings.basic.autoConvertSessionsOnExit.disabled',
  'settings.basic.autoConvertSessionsOnExit.hint',
  'history.convertAllToCliSessions',
  'history.convertAllToCliSessionsTooltip',
] as const;

/**
 * Historical gaps: keys present in en.json that are deliberately NOT translated
 * in some locales. Every entry must carry a reason, and `does not rot` below
 * fails if an entry no longer describes reality (so a fixed locale forces the
 * allowlist to shrink instead of lingering).
 */
const INTENTIONAL_GAPS: Array<{
  /** Exact keys, or prefixes ending in `*`. */
  keys: string[];
  /** Locale file names (without .json) the gap applies to. `*` means every locale. */
  locales: string[];
  reason: string;
}> = [
  {
    keys: [
      'settings.basic.nodePath.invalidPath',
      'settings.basic.nodePath.pathNotFound',
      'settings.basic.nodePath.invalidFileName',
      'settings.basic.nodePath.cannotExecute',
    ],
    locales: ['es', 'fr', 'hi', 'ja', 'ko', 'pt-BR', 'ru', 'zh-TW'],
    reason:
      'Node path validation messages shipped in English only; they are rare error states and every non-English locale falls back to the en.json wording.',
  },
  {
    keys: ['settings.basic.commitGeneration.*', 'settings.basic.statusBarWidget.*'],
    locales: ['es', 'fr', 'hi', 'ja', 'ko', 'ru', 'zh-TW'],
    reason:
      'Commit generation and status bar widget settings were added in English and never translated; pending translator pass.',
  },
  {
    keys: ['settings.basic.diffTheme.*'],
    locales: ['es', 'fr', 'hi', 'ja', 'ko', 'ru', 'zh-TW'],
    reason:
      'Diff theme options were added in English and never translated; pending translator pass.',
  },
  {
    keys: ['history.timeAgo.*'],
    locales: ['ru'],
    reason:
      'Russian uses i18next plural suffixes (yearsAgo_one / _few / _many / _other) plus justNow, so it legitimately has no plain yearsAgo keys. Structural, not a translation gap.',
  },
];

function localeFiles(): string[] {
  return readdirSync(LOCALES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
}

function readLocale(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${name}.json`), 'utf8'));
}

/** Flattens nested translation objects into `a.b.c` paths. */
function flatten(value: unknown, prefix = ''): Set<string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return new Set(prefix ? [prefix] : []);
  }
  const keys = new Set<string>();
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    for (const leaf of flatten(child, path)) keys.add(leaf);
  }
  return keys;
}

function inParitySection(key: string): boolean {
  return PARITY_SECTIONS.some(
    (section) => key === section || key.startsWith(`${section}.`),
  );
}

function isAllowlisted(key: string, locale: string): boolean {
  return INTENTIONAL_GAPS.some(
    (gap) =>
      (gap.locales.includes('*') || gap.locales.includes(locale)) &&
      gap.keys.some((pattern) =>
        pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern,
      ),
  );
}

const locales = localeFiles();
const reference = readLocale(REFERENCE_LOCALE);
const referenceKeys = [...flatten(reference)].filter(inParitySection);

describe('locale key parity', () => {
  it('has the reference locale and every locale file in its resources', () => {
    expect(locales).toContain(REFERENCE_LOCALE);
    expect(locales.length).toBeGreaterThan(1);
    // config.ts registers one resource per file; a locale file that nobody loads
    // would make the whole parity guarantee a no-op for that language.
    const config = readFileSync(join(__dirname, 'config.ts'), 'utf8');
    for (const locale of locales) {
      expect(config).toContain(`./locales/${locale}.json`);
    }
  });

  it('covers the settings.basic and history sections in the reference locale', () => {
    expect(referenceKeys.length).toBeGreaterThan(100);
    expect(referenceKeys.some((key) => key.startsWith('settings.basic.'))).toBe(true);
    expect(referenceKeys.some((key) => key.startsWith('history.'))).toBe(true);
  });

  it.each(locales.filter((locale) => locale !== REFERENCE_LOCALE))(
    '%s.json defines every settings.basic/history key of en.json',
    (locale) => {
      const localeKeys = flatten(readLocale(locale));
      const missing = referenceKeys.filter(
        (key) => !localeKeys.has(key) && !isAllowlisted(key, locale),
      );

      expect(missing).toEqual([]);
    },
  );

  it('translates the auto-convert-sessions feature keys in every locale', () => {
    for (const locale of locales) {
      const localeKeys = flatten(readLocale(locale));
      const missing = FEATURE_KEYS.filter(
        (key) => !localeKeys.has(key) && !isAllowlisted(key, locale),
      );

      expect({ locale, missing }).toEqual({ locale, missing: [] });
    }
  });

  it('keeps the intentional-gap allowlist from rotting', () => {
    // An allowlist entry that no longer matches reality (the key was translated,
    // or the locale stopped existing) is dead weight that would hide a real gap,
    // so force it to be removed.
    const stale: string[] = [];

    for (const gap of INTENTIONAL_GAPS) {
      const applies = locales.filter(
        (locale) => gap.locales.includes('*') || gap.locales.includes(locale),
      );
      if (applies.length === 0) stale.push(`gap with locales ${gap.locales.join(',')}: no such locale`);

      for (const locale of applies) {
        const localeKeys = flatten(readLocale(locale));
        for (const pattern of gap.keys) {
          const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
          const stillMissing = [...referenceKeys].some(
            (key) => key.startsWith(prefix) && !localeKeys.has(key),
          );
          if (!stillMissing) stale.push(`${locale}: ${pattern}`);
        }
      }
    }

    expect(stale).toEqual([]);
  });
});
