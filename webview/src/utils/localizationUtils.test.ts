import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_NOT_DELIVERED_REASONS,
  WORKSPACE_SUBSTITUTION_REASONS,
  createLocalizeMessage,
} from './localizationUtils';

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

// ---------------------------------------------------------------------------
// Story 1.6 — image attachment non-delivery notices (CAP-7, C10, NFR8).
//
// The gemini bridge emits, per rejected attachment, a pre-spawn leading
// [CONTENT_DELTA]: `[Notice] Attachment not delivered: "<name>" (<reason>).\n\n`
// (ai-bridge/services/gemini/message-service.test.js pins the emission; the
// reason literals are a CLOSED set — same design as
// WORKSPACE_SUBSTITUTION_REASONS — and this file is their lockstep anchor).
//
// i18n shape mirrors the workspace pair: a sentence template with
// {{name}}/{{reason}} plus one key per reason, grouped under
// `aiBridge.attachmentNotDelivered` (nested objects are established locale
// style — chat.search, settings.pet).
// ---------------------------------------------------------------------------

const ATTACHMENT_NOTICE_PREFIX = '[Notice] Attachment not delivered: ';

const attachmentNotice = (name: string, reason: string) =>
  `${ATTACHMENT_NOTICE_PREFIX}"${name}" (${reason}).\n\n`;

/**
 * Reason literal → i18n key. Total over ATTACHMENT_NOT_DELIVERED_REASONS
 * (enforced by the satisfies clause): a reason added to the bridge set
 * without a mapping fails the typecheck AND the pinning test below.
 */
const ATTACHMENT_REASON_KEYS = {
  'only image attachments are supported': 'aiBridge.attachmentNotDelivered.nonImage',
  'image exceeds the 2 MB per-image limit': 'aiBridge.attachmentNotDelivered.tooLarge',
  'image data is missing or unreadable': 'aiBridge.attachmentNotDelivered.invalid',
} as const satisfies Record<(typeof ATTACHMENT_NOT_DELIVERED_REASONS)[number], string>;

describe('createLocalizeMessage — ai-bridge attachment non-delivery notices (Story 1.6)', () => {
  it('maps each emitted notice onto aiBridge.attachmentNotDelivered.notice with a localized reason', () => {
    for (const reason of ATTACHMENT_NOT_DELIVERED_REASONS) {
      const key = ATTACHMENT_REASON_KEYS[reason as keyof typeof ATTACHMENT_REASON_KEYS];
      const t = makeT();
      const localize = createLocalizeMessage(t as never);
      const localized = localize(attachmentNotice('notes.txt', reason));

      expect(t).toHaveBeenCalledWith('aiBridge.attachmentNotDelivered.notice', {
        name: 'notes.txt',
        // The reason is translated through its own i18n key (NFR8) — never the
        // raw English string interpolated into a localized template.
        reason: `[${key}]`,
      });
      expect(t).toHaveBeenCalledWith(key);
      expect(localized, reason).toContain('[aiBridge.attachmentNotDelivered.notice]');
      expect(localized, reason).toContain('name=notes.txt');
      // The raw English sentence must not survive localization.
      expect(localized, reason).not.toContain('Attachment not delivered');
    }
  });

  it('localizes EVERY concatenated notice of a multi-rejection turn, not just the first (review M1)', () => {
    // AC5 concatenates one notice per rejection into the leading delta; with a
    // single-shot match only notice 1 localized and notices 2..N rendered raw
    // English. The makeT stand-in echoes localized templates (no English),
    // i.e. any non-en locale rendering; the answer text interleaves after the
    // notices, as the turn's own delta does on the stream.
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const answer = 'Вот ответ на ваш вопрос.';
    const emitted =
      attachmentNotice('notes.txt', 'only image attachments are supported')
      + attachmentNotice('huge.png', 'image exceeds the 2 MB per-image limit')
      + answer;
    const localized = localize(emitted);

    // NO raw English notice sentence survives — not even for notice 2.
    expect(localized).not.toContain('Attachment not delivered');
    // Both names localize through the template, in emission order.
    const first = localized.indexOf('name=notes.txt');
    const second = localized.indexOf('name=huge.png');
    expect(first, 'notice 1 must localize').toBeGreaterThanOrEqual(0);
    expect(second, 'notice 2 must localize').toBeGreaterThan(first);
    expect(t).toHaveBeenCalledWith('aiBridge.attachmentNotDelivered.nonImage');
    expect(t).toHaveBeenCalledWith('aiBridge.attachmentNotDelivered.tooLarge');
    expect(t.mock.calls.filter(([key]) => key === 'aiBridge.attachmentNotDelivered.notice')).toHaveLength(2);
    // The answer text survives the notices untouched.
    expect(localized).toContain(answer);
  });

  it('consumes the trailing blank line from the emitted notice', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const localized = localize(attachmentNotice('shot.png', 'image data is missing or unreadable'));

    // Same contract as the workspace notice: the consumed \n\n is re-appended
    // so a following answer stays visually separated either way.
    expect(localized.endsWith('\n\n')).toBe(true);
  });

  it('leaves an unknown-reason attachment notice completely untouched (closed set)', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const emitted = attachmentNotice('x.png', 'some future reason');
    expect(localize(emitted)).toBe(emitted);
    expect(t).not.toHaveBeenCalledWith('aiBridge.attachmentNotDelivered.notice', expect.anything());
  });

  it('does not treat other [Notice] text as an attachment rejection', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    // A valid workspace notice must localize through the WORKSPACE channel —
    // and never trip the attachment mapping.
    localize('[Notice] Working directory substituted: requested "/a", using "/b" (temporary directory).\n\n');
    expect(t).toHaveBeenCalledWith('aiBridge.workspaceSubstituted', expect.anything());
    expect(t).not.toHaveBeenCalledWith('aiBridge.attachmentNotDelivered.notice', expect.anything());
  });
});

describe('attachment notice i18n contract (Story 1.6, NFR8)', () => {
  it('pins the webview reason set to the literals the gemini service emits', () => {
    expect([...ATTACHMENT_NOT_DELIVERED_REASONS].sort()).toEqual([
      'image data is missing or unreadable',
      'image exceeds the 2 MB per-image limit',
      'only image attachments are supported',
    ]);
    // Lockstep both ways: every literal must exist verbatim in the service
    // source (same rule as the workspace reasons' JSDoc mandate). The "2 MB"
    // wording is pinned too — the bridge test derives it from
    // GROK_MAX_IMAGE_BYTES, so a cap change must consciously update BOTH.
    const serviceSource = readFileSync(SERVICE_SOURCE_PATH, 'utf8');
    expect(serviceSource).toContain(ATTACHMENT_NOTICE_PREFIX);
    for (const reason of ATTACHMENT_NOT_DELIVERED_REASONS) {
      expect(serviceSource, `service source must contain "${reason}" verbatim`).toContain(reason);
    }
  });

  it('every locale ships the notice template and all three reason keys (NFR8)', () => {
    for (const locale of LOCALES) {
      const aiBridge = JSON.parse(readFileSync(localePath(locale), 'utf8')).aiBridge;
      const group = aiBridge.attachmentNotDelivered as
        | { notice?: string; nonImage?: string; tooLarge?: string; invalid?: string }
        | undefined;
      expect(group, `${locale}.aiBridge.attachmentNotDelivered`).toBeTruthy();
      expect(group!.notice, `${locale}.notice`).toContain('{{name}}');
      expect(group!.notice, `${locale}.notice`).toContain('{{reason}}');
      for (const key of ['nonImage', 'tooLarge', 'invalid'] as const) {
        expect(typeof group![key], `${locale}.${key}`).toBe('string');
        expect((group![key] as string).length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Gemini bridge remedy blocks (NFR8) — formatGeminiError's auth remedy and
// buildIdleReapMessage's reap message (ai-bridge/services/gemini/
// message-service.js). Every STATIC line of both blocks maps through an
// exact-match entry in aiBridgeMessageMap; the reap headline's silence window
// is the one dynamic capture (GEMINI_IDLE_REAP_STOPPED_RE), and the auth
// block's "- Error details:" tail localizes as a label only — the tail is the
// CLI's own error text and must survive verbatim.
// ---------------------------------------------------------------------------

/** The full auth-remedy block the bridge emits for a credential failure. */
const authRemedyBlock = (details: string) => [
  'Gemini CLI authentication required:',
  '- Cause: The Gemini CLI (agy) is not logged in or credentials have expired.',
  "- Resolution: Run 'agy' in an external terminal and complete the interactive Google Sign-In flow.",
  '- Note: This plugin does not manage Google credentials or perform Google login in-plugin.',
  '',
  `- Error details: ${details}`,
].join('\n');

/** The full reap message the bridge emits when the silence window trips. */
const idleReapBlock = (windowText: string, processAlive: boolean) => [
  `Gemini turn stopped automatically: no output from the Gemini CLI (agy) for ${windowText}.`,
  processAlive
    ? '- Likely cause: the CLI process was alive but silent — it is likely stuck at an interactive prompt (most commonly authentication) or stalled on the backend/network.'
    : '- Likely cause: the CLI process had already exited without delivering a result.',
  "- What to do: run 'agy' in an external terminal to check your login, then cancel and retry; if the turn was legitimately silent (e.g. a long build), raise the window.",
  '- This limit is configurable: set gemini.idleReapMinutes in the Gemini plugin settings (0 disables automatic stopping).',
].join('\n');

/** Static line literal → i18n key. Total over both blocks' static lines. */
const GEMINI_STATIC_LINE_KEYS = {
  'Gemini CLI authentication required:': 'aiBridge.geminiAuthRequired',
  '- Cause: The Gemini CLI (agy) is not logged in or credentials have expired.': 'aiBridge.geminiAuthCause',
  "- Resolution: Run 'agy' in an external terminal and complete the interactive Google Sign-In flow.": 'aiBridge.geminiAuthResolution',
  '- Note: This plugin does not manage Google credentials or perform Google login in-plugin.': 'aiBridge.geminiAuthNote',
  '- Likely cause: the CLI process was alive but silent — it is likely stuck at an interactive prompt (most commonly authentication) or stalled on the backend/network.': 'aiBridge.geminiIdleReapCauseAlive',
  '- Likely cause: the CLI process had already exited without delivering a result.': 'aiBridge.geminiIdleReapCauseExited',
  "- What to do: run 'agy' in an external terminal to check your login, then cancel and retry; if the turn was legitimately silent (e.g. a long build), raise the window.": 'aiBridge.geminiIdleReapWhatToDo',
  '- This limit is configurable: set gemini.idleReapMinutes in the Gemini plugin settings (0 disables automatic stopping).': 'aiBridge.geminiIdleReapSetting',
} as const;

/** The keys of one block's OWN static lines (a block never contains the other's). */
const AUTH_LINE_KEYS = [
  'aiBridge.geminiAuthRequired',
  'aiBridge.geminiAuthCause',
  'aiBridge.geminiAuthResolution',
  'aiBridge.geminiAuthNote',
] as const;
const REAP_LINE_KEYS = (causeKey: string) => [
  'aiBridge.geminiIdleReapStopped',
  causeKey,
  'aiBridge.geminiIdleReapWhatToDo',
  'aiBridge.geminiIdleReapSetting',
] as const;

describe('createLocalizeMessage — gemini auth remedy block (NFR8)', () => {
  it('maps every static line onto its i18n key and keeps the error tail raw', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const localized = localize(authRemedyBlock('agy: no active credentials found'));

    for (const key of AUTH_LINE_KEYS) {
      expect(localized).toContain(`[${key}]`);
    }
    // The label localizes; the CLI's own error text after it must survive
    // verbatim — it is the only diagnostic the user can act on.
    expect(localized).toContain('- [aiBridge.geminiErrorDetails]: agy: no active credentials found');
    // No raw English remedy line survives.
    expect(localized).not.toContain('Gemini CLI authentication required');
    expect(localized).not.toContain('credentials have expired');
    expect(localized).not.toContain('Google Sign-In');
  });

  it('leaves a non-auth gemini error untouched', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const emitted = 'agy: the model stream closed unexpectedly';
    expect(localize(emitted)).toBe(emitted);
  });
});

describe('createLocalizeMessage — gemini idle-reap message (NFR8)', () => {
  it('localizes the whole block, extracting the silence window as a param', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const localized = localize(idleReapBlock('30 minutes', true));

    expect(t).toHaveBeenCalledWith('aiBridge.geminiIdleReapStopped', { window: '30 minutes' });
    for (const key of REAP_LINE_KEYS('aiBridge.geminiIdleReapCauseAlive')) {
      expect(localized).toContain(`[${key}]`);
    }
    // No raw English line of the block survives.
    expect(localized).not.toContain('Gemini turn stopped automatically');
    expect(localized).not.toContain('Likely cause');
    expect(localized).not.toContain('What to do');
    expect(localized).not.toContain('idleReapMinutes');
  });

  it('localizes the already-exited cause variant through its own key', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    const localized = localize(idleReapBlock('45 seconds', false));

    expect(localized).toContain('[aiBridge.geminiIdleReapCauseExited]');
    // The alive variant's key must not appear — makeT renders every localized
    // template as its key, so a raw `[key]` in the output IS the signal.
    expect(localized).not.toContain('[aiBridge.geminiIdleReapCauseAlive]');
    expect(localized).toContain('window=45 seconds');
  });

  it('captures every window shape formatIdleWindow can emit', () => {
    // Singular, fractional (the dot must survive inside the capture), and
    // sub-minute seconds rendering.
    for (const windowText of ['1 minute', '1.5 minutes', '45 seconds', '1 second']) {
      const t = makeT();
      createLocalizeMessage(t as never)(idleReapBlock(windowText, true));
      expect(t).toHaveBeenCalledWith('aiBridge.geminiIdleReapStopped', { window: windowText });
    }
  });

  it('does not treat ordinary gemini output as a reap headline', () => {
    const t = makeT();
    const localize = createLocalizeMessage(t as never);
    localize('no output from the Gemini CLI (agy) for a while, but not the reap message');
    expect(t).not.toHaveBeenCalledWith('aiBridge.geminiIdleReapStopped', expect.anything());
  });
});

describe('gemini bridge remedy i18n contract (NFR8)', () => {
  it('pins every static line to the gemini service source', () => {
    // A bridge-side rewording must break this test, not ship half-English
    // remedy blocks (same scrape rule as the workspace/attachment contracts).
    // The auth lines and the reap remedy/setting lines are fully static and
    // must appear verbatim; the two cause lines are TEMPLATED in the service
    // ("- Likely cause: ${observation}.") — their source-verbatim halves are
    // the observation literals, while the webview map carries the composed
    // full lines.
    const serviceSource = readFileSync(SERVICE_SOURCE_PATH, 'utf8');
    const verbatimLines = [
      'Gemini CLI authentication required:',
      '- Cause: The Gemini CLI (agy) is not logged in or credentials have expired.',
      "- Resolution: Run 'agy' in an external terminal and complete the interactive Google Sign-In flow.",
      '- Note: This plugin does not manage Google credentials or perform Google login in-plugin.',
      "- What to do: run 'agy' in an external terminal to check your login, then cancel and retry; if the turn was legitimately silent (e.g. a long build), raise the window.",
      '- This limit is configurable: set gemini.idleReapMinutes in the Gemini plugin settings (0 disables automatic stopping).',
    ];
    for (const line of verbatimLines) {
      expect(serviceSource, `service source must contain "${line}" verbatim`).toContain(line);
    }
    expect(serviceSource).toContain('- Likely cause: ${observation}.');
    expect(serviceSource).toContain(
      'the CLI process was alive but silent — it is likely stuck at an interactive prompt (most commonly authentication) or stalled on the backend/network'
    );
    expect(serviceSource).toContain('the CLI process had already exited without delivering a result');
    // The dynamic halves' anchors are pinned too: the reap headline prefix
    // (the regex above matches the rest) and the error-details label.
    expect(serviceSource).toContain('Gemini turn stopped automatically: no output from the Gemini CLI (agy) for ');
    expect(serviceSource).toContain('- Error details: ${text}');
  });

  it('every locale ships all ten gemini remedy keys (NFR8)', () => {
    const keys = [
      ...Object.values(GEMINI_STATIC_LINE_KEYS).map((key) => key.replace('aiBridge.', '')),
      'geminiErrorDetails',
      'geminiIdleReapStopped',
    ];
    for (const locale of LOCALES) {
      const aiBridge = JSON.parse(readFileSync(localePath(locale), 'utf8')).aiBridge;
      for (const key of keys) {
        expect(typeof aiBridge[key], `${locale}.${key}`).toBe('string');
        expect((aiBridge[key] as string).length, `${locale}.${key}`).toBeGreaterThan(0);
      }
      expect(aiBridge.geminiIdleReapStopped, `${locale}.geminiIdleReapStopped`).toContain('{{window}}');
    }
  });
});
