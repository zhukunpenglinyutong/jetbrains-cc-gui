import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLocalizeMessage, WORKSPACE_SUBSTITUTION_REASONS } from './localizationUtils';

/**
 * Minimal t() stand-in: records the key + interpolation params and echoes
 * `[key] {param=value}` so assertions can verify both the resolved key and
 * the extracted parameters.
 */
function makeT() {
  return vi.fn((key: string, params?: Record<string, unknown>) => {
    if (!params) return `[${key}]`;
    return `[${key}] ${Object.entries(params)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')}`;
  });
}

// Exact English text emitted by ai-bridge/services/gemini/message-service.js
// (leading content delta of a substituted turn, trailing \n\n included).
const EMITTED_PLUGIN_DIR =
  '[Notice] Working directory substituted: requested "/unsafe/plugin/dir", using "/home/user/project" (plugin-internal directory).\n\n';

describe('createLocalizeMessage — ai-bridge workspace substitution notice', () => {
  it('maps the emitted English notice onto aiBridge.workspaceSubstituted with params', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const localized = localize(EMITTED_PLUGIN_DIR);

    expect(t).toHaveBeenCalledWith('aiBridge.workspaceSubstituted', {
      requested: '/unsafe/plugin/dir',
      effective: '/home/user/project',
      // The reason is translated through its own i18n key (NFR8) — never the
      // raw English string.
      reason: '[aiBridge.workspaceReasonPluginInternal]',
    });
    expect(t).toHaveBeenCalledWith('aiBridge.workspaceReasonPluginInternal');
    expect(localized).toContain('[aiBridge.workspaceSubstituted]');
    expect(localized).toContain('requested=/unsafe/plugin/dir');
    expect(localized).toContain('effective=/home/user/project');
    expect(localized).toContain('reason=[aiBridge.workspaceReasonPluginInternal]');
    // The raw English sentence must not survive localization
    expect(localized).not.toContain('Working directory substituted');
  });

  it('consumes the trailing blank line from the emitted notice', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const localized = localize(EMITTED_PLUGIN_DIR);

    // The template provides the spacing; the consumed \n\n is re-appended so a
    // following answer text stays visually separated either way.
    expect(localized.endsWith('\n\n')).toBe(true);
    expect(localized).not.toContain(')\n\n\n');
  });

  it('localizes every reason of the closed set', () => {
    const cases: Array<[string, string]> = [
      ['unsafe working directory', 'aiBridge.workspaceReasonUnsafe'],
      ['plugin-internal directory', 'aiBridge.workspaceReasonPluginInternal'],
      ['directory does not exist', 'aiBridge.workspaceReasonMissing'],
      ['not a directory', 'aiBridge.workspaceReasonNotADirectory'],
      ['temporary directory', 'aiBridge.workspaceReasonTemporary'],
    ];
    for (const [english, key] of cases) {
      const t = makeT();
      const localize = createLocalizeMessage(t as never);
      localize(
        `[Notice] Working directory substituted: requested "/a/b", using "/c" (${english}).\n\n`
      );
      expect(t).toHaveBeenCalledWith(key);
      expect(t).toHaveBeenCalledWith('aiBridge.workspaceSubstituted', {
        requested: '/a/b',
        effective: '/c',
        reason: `[${key}]`,
      });
    }
  });

  it('keeps raw English paths containing quotes and parentheses parseable', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    // A workspace named with a quote and a paren must not break the groups.
    const tricky = '/opt/weird ("quoted") dir/plugin';
    localize(
      `[Notice] Working directory substituted: requested "${tricky}", using "/home/u" (plugin-internal directory).\n\n`
    );
    expect(t).toHaveBeenCalledWith('aiBridge.workspaceSubstituted', {
      requested: tricky,
      effective: '/home/u',
      reason: '[aiBridge.workspaceReasonPluginInternal]',
    });
  });

  it('leaves a notice with an unknown reason completely untouched (no i18n, no template)', () => {
    // R-8: the reason group is a CLOSED alternation. A reason the webview
    // cannot localize must not be interpolated into a localized template —
    // the raw English text passes through verbatim instead.
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const emitted =
      '[Notice] Working directory substituted: requested "/a", using "/b" (some future reason).\n\n';
    expect(localize(emitted)).toBe(emitted);
    expect(t).not.toHaveBeenCalledWith('aiBridge.workspaceSubstituted', expect.anything());
    expect(t).not.toHaveBeenCalledWith('aiBridge.workspaceReasonUnsafe');
  });

  it('does not treat unrelated bracketed text as a substitution notice', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    localize('ordinary message with [Notice] nothing else');
    expect(t).not.toHaveBeenCalledWith('aiBridge.workspaceSubstituted', expect.anything());
  });

  it('leaves plain text untouched', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    expect(localize('no markers here')).toBe('no markers here');
  });
});

/**
 * R-14 contract tests: the webview notice regex + the 10 locale files must
 * stay in lockstep with the reason literals the ai-bridge service can emit.
 * A new/renamed classifier string fails here instead of rendering a raw
 * English reason (or an untranslated notice) in the chat bubble.
 */
const REASON_KEYS = [
  'workspaceReasonUnsafe',
  'workspaceReasonPluginInternal',
  'workspaceReasonMissing',
  'workspaceReasonNotADirectory',
  'workspaceReasonTemporary',
] as const;

// happy-dom overrides import.meta.url with a non-file URL, so file access goes
// through cwd (vitest always runs from webview/).
const WEBVIEW_ROOT = process.cwd();
const SERVICE_SOURCE_PATH = join(WEBVIEW_ROOT, '..', 'ai-bridge', 'services', 'gemini', 'message-service.js');
const LOCALES_DIR = join(WEBVIEW_ROOT, 'src', 'i18n', 'locales');
const localePath = (locale: string) => join(LOCALES_DIR, `${locale}.json`);
// Derived from the filesystem: a locale file added later is picked up
// automatically instead of silently missing its NFR8 assertions.
const LOCALES = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

/** The reason string literals of classifyWorkspaceSubstitutionReason. */
function serviceReasonLiterals(): string[] {
  const source = readFileSync(SERVICE_SOURCE_PATH, 'utf8');
  const fnSource = source.match(/export function classifyWorkspaceSubstitutionReason[\s\S]*?\n}\n/)?.[0];
  expect(fnSource, 'classifier function found in message-service.js').toBeTruthy();
  // Extract EVERY plain string literal the function can return — a reason need
  // not contain the word "directory" (a future "network share" literal must
  // fail this contract, not slip past a keyword filter). Deduped: a literal
  // may be returned from more than one branch.
  return [...new Set([...fnSource!.matchAll(/return '([^']+)'/g)].map((m) => m[1]))];
}

describe('workspace notice i18n contract (R-14)', () => {
  it('derives the locale list from src/i18n/locales (no silent gaps)', () => {
    // If the readdir ever comes back short (wrong cwd, moved dir), the per-
    // locale loop below would pass vacuously — pin the discovery itself.
    expect(LOCALES.length, `discovered: ${LOCALES.join(',')}`).toBeGreaterThanOrEqual(10);
    for (const must of ['en', 'ru', 'zh-TW'] as const) {
      expect(LOCALES, `must include ${must}`).toContain(must);
    }
  });

  it('pins the webview reason set to the service classifier literals', () => {
    expect(serviceReasonLiterals().sort()).toEqual([...WORKSPACE_SUBSTITUTION_REASONS].sort());
  });

  it('localizes a notice carrying every literal the service can emit', () => {
    for (const reason of serviceReasonLiterals()) {
      const t = makeT();
      const localized = createLocalizeMessage(t as never)(
        `[Notice] Working directory substituted: requested "/a", using "/b" (${reason}).\n\n`
      );
      expect(localized, reason).toContain('[aiBridge.workspaceSubstituted]');
      expect(localized, reason).not.toContain('Working directory substituted');
      const call = t.mock.calls.find(([key]) => key === 'aiBridge.workspaceSubstituted');
      expect(call, reason).toBeTruthy();
      const reasonArg = (call![1] as { reason: string }).reason;
      expect(reasonArg, reason).toMatch(/^\[aiBridge\.workspaceReason/);
    }
  });

  it('every locale ships the notice template and all five reason keys (NFR8)', () => {
    for (const locale of LOCALES) {
      const aiBridge = JSON.parse(readFileSync(localePath(locale), 'utf8')).aiBridge;
      expect(aiBridge.workspaceSubstituted, locale).toBeTruthy();
      expect(aiBridge.workspaceSubstituted, locale).toContain('{{requested}}');
      expect(aiBridge.workspaceSubstituted, locale).toContain('{{effective}}');
      expect(aiBridge.workspaceSubstituted, locale).toContain('{{reason}}');
      for (const key of REASON_KEYS) {
        expect(typeof aiBridge[key], `${locale}.${key}`).toBe('string');
        expect((aiBridge[key] as string).length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
