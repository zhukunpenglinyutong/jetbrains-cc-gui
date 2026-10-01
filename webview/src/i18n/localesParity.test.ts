import { describe, it, expect } from 'vitest';
import en from './locales/en.json';
import ru from './locales/ru.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import ptBR from './locales/pt-BR.json';
import zh from './locales/zh.json';
import zhTW from './locales/zh-TW.json';

/**
 * Locale parity for the features this plugin actually ships strings for.
 *
 * The whole-file comparison these locales would otherwise need is not useful:
 * a large share of the tree is machine-translated or legacy and drifts freely.
 * What must not drift is the UI a user is looking at, so each feature below
 * names a root and every leaf beneath it is required in all ten files. A
 * missing key would render as the raw dotted path in the UI (react-i18next
 * falls back to English, but a key that is missing everywhere falls through to
 * the key itself), and the test names the feature so the report says which
 * surface regressed.
 */
const LOCALES: Record<string, Record<string, unknown>> = {
  en,
  ru,
  es,
  fr,
  hi,
  ja,
  ko,
  'pt-BR': ptBR,
  zh,
  'zh-TW': zhTW,
};

function lookup(root: unknown, path: string): unknown {
  let node = root;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Keys the auto-discovery feature added, relative to the feature root.
 *
 * Listed explicitly so the test guards the feature's own strings instead of
 * inheriting whatever drift the surrounding tree happens to carry. Adding a
 * string to the feature means adding it here too — that is the intended
 * reminder, and the failure message names the feature.
 */
const FEATURE_KEYS: Record<string, string[]> = {
  'auto-discovered agents': [
    'scopeGlobal',
    'scopeLocal',
    'scopeStore',
    'totalCount',
    'refresh',
    'openFile',
    'openAtLine',
    'searchPlaceholder',
    'searchClear',
    'noSearchResults',
    'matchCount',
    'readOnly',
    'readOnlyHint',
    'disabled',
    'showDetails',
    'hideDetails',
    'notSpecified',
    'operationFailedReason',
    'toolsSummaryNone',
    'toolsSummaryNamed_other',
    'disallowedSummary_other',
    'permissionSummary',
    'backgroundSummary',
    'fieldDescription',
    'fieldModel',
    'fieldPermissionMode',
    'fieldTools',
    'fieldDisallowedTools',
    'fieldMaxTurns',
    'fieldSkills',
    'fieldMcpServers',
    'fieldHooks',
    'fieldMemory',
    'fieldBackground',
    'fieldEffort',
    'fieldIsolation',
    'fieldColor',
    'fieldInitialPrompt',
    'fieldOmitClaudeMd',
    'fieldExperimental',
    'fieldPrompt',
    'fieldPath',
  ],
};

describe('locale parity', () => {
  for (const [feature, keys] of Object.entries(FEATURE_KEYS)) {
    describe(feature, () => {
      const required = keys.map((key) => `settings.agent.${key}`);

      it('is a non-empty key set in the source locale', () => {
        expect(required.length).toBeGreaterThan(0);
      });

      for (const [locale, tree] of Object.entries(LOCALES)) {
        if (locale === 'en') continue;

        it(`${locale} defines every key`, () => {
          const missing = required.filter(
            (path) => lookup(tree, path) === undefined || lookup(tree, path) === null
          );
          expect(missing).toEqual([]);
        });
      }
    });
  }

  it('locales that distinguish "one" define every _one variant', () => {
    // zh/ko/ja have a single plural category, so "_other" is their only form
    // and a missing "_one" is correct rather than a gap. Every other locale
    // does distinguish it, and there a count of 1 would otherwise fall through
    // to English mid-sentence.
    const singleForm = new Set(['zh', 'zh-TW', 'ja', 'ko']);
    const groups = [
      'toolsSummaryNamed',
      'disallowedSummary',
    ];
    const problems: string[] = [];

    for (const [locale, tree] of Object.entries(LOCALES)) {
      if (singleForm.has(locale)) continue;
      for (const group of groups) {
        if (lookup(tree, `settings.agent.${group}_one`) === undefined) {
          problems.push(`${locale}: ${group}_one`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('en defines no plural key without a matching "other" fallback', () => {
    // i18next resolves a category by suffix; a key with only "_many" and no
    // "_other" renders as the raw key for counts of 1.
    const agent = lookup(en, 'settings.agent') as Record<string, unknown>;
    const offenders: string[] = [];

    for (const key of Object.keys(agent)) {
      const match = /^(.*)_(zero|one|two|few|many|others?)$/.exec(key);
      if (!match) continue;
      if (!(`${match[1]}_other` in agent)) offenders.push(key);
    }

    expect(offenders).toEqual([]);
  });
});
