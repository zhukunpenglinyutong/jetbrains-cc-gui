import { describe, expect, it } from 'vitest';
import en from './en.json';
import es from './es.json';
import fr from './fr.json';
import hi from './hi.json';
import ja from './ja.json';
import ko from './ko.json';
import ptBR from './pt-BR.json';
import ru from './ru.json';
import zhTW from './zh-TW.json';
import zh from './zh.json';

/**
 * Story 1.10: the idle-reap settings field is user-facing — the numeric
 * window input, its help text, and the "disable" affordance must exist in
 * ALL 10 locales (NFR8). This pins the key NAMES as a contract (the dev adds
 * the translations at green); renaming a key requires updating this test
 * coherently, same rule as the Story 1.9 `chat.tokenUsageThinking` pin.
 *
 * The component render/persist test itself lands with the settings field
 * (its placement is a dev decision — no provider-settings-field precedent
 * exists in this tree yet; see the ATDD checklist's flagged ambiguities).
 */
const LOCALES: Record<string, Record<string, unknown>> = {
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
  fr: fr as unknown as Record<string, unknown>,
  hi: hi as unknown as Record<string, unknown>,
  ja: ja as unknown as Record<string, unknown>,
  ko: ko as unknown as Record<string, unknown>,
  'pt-BR': ptBR as unknown as Record<string, unknown>,
  ru: ru as unknown as Record<string, unknown>,
  'zh-TW': zhTW as unknown as Record<string, unknown>,
  zh: zh as unknown as Record<string, unknown>,
};

const PINNED_LEAVES = ['idleReapLabel', 'idleReapHelp', 'idleReapDisabled'] as const;

function pick(dict: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = dict;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

describe('gemini idle-reap settings i18n (Story 1.10, NFR8)', () => {
  for (const [locale, dict] of Object.entries(LOCALES)) {
    it(`${locale}: carries the idle-reap label, help, and disable strings`, () => {
      for (const leaf of PINNED_LEAVES) {
        const value = pick(dict, ['settings', 'gemini', leaf]);
        expect(
          typeof value === 'string' && value.length > 0,
          `settings.gemini.${leaf} must be a non-empty localized string in ${locale}.json`,
        ).toBe(true);
      }
    });
  }
});
