import { describe, expect, it } from 'vitest';
import { matchErrorPattern } from './errorMatcher';
import patternsData from '../data/errorPatterns.json';

describe('matchErrorPattern', () => {
  it('returns null for empty input', () => {
    expect(matchErrorPattern('')).toBeNull();
  });

  it.each([
    ['thread/resume: thread saved already has an active writer', 'codexWriterConflict'],
    ['thread saved already has a live local writer', 'codexWriterConflict'],
    ['Codex thread is already owned by another window', 'codexWriterConflict'],
    ['Codex thread is already owned by another chat window', 'codexWriterConflict'],
    ['thread/resume: thread saved is closing; retry thread/resume after the thread is closed', 'codexThreadClosing'],
    ['no rollout found for thread id saved', 'codexThreadHistoryMissing'],
    ['thread/resume: no rollout found for conversation id saved', 'codexThreadHistoryMissing'],
    ['thread/resume: session saved is archived; unarchive it first', 'codexThreadArchived'],
    ['thread/resume: required MCP servers failed to initialize: required_broken', 'codexThreadResumeConfiguration'],
    ['required MCP servers failed to initialize: required_broken', 'codexThreadResumeConfiguration'],
    ['thread/resume: failed to load configuration: invalid TOML', 'codexThreadResumeConfiguration'],
    ['thread/resume: RPC timed out', 'codexThreadResume'],
    ['thread/resume failed: unexpected native error', 'codexThreadResume'],
  ])('diagnoses the actual Codex recovery failure: %s', (text, code) => {
    expect(matchErrorPattern(text)?.code).toBe(code);
  });

  it.each([
    'failed to load configuration: invalid TOML',
    'thread discussion failed',
    'network request failed',
    'session title was archived yesterday',
  ])('does not diagnose unrelated errors as Codex recovery failures: %s', (text) => {
    expect(matchErrorPattern(text)).toBeNull();
  });

  it.each([
    'Invalid request: unknown variant `auto_review`, expected `user` or `guardian_subagent`',
    'thread/resume: Invalid request: unknown variant `auto_review`, expected `user` or `guardian_subagent`',
  ])('explains a Codex CLI too old for the automatic reviewer: %s', (text) => {
    expect(matchErrorPattern(text)?.code).toBe('codexCliVersionTooOld');
  });

  it.each([
    // A variant a newer CLI removed must not advise updating the CLI.
    'Invalid request: unknown variant `untrusted`, expected `never` or `on-request`',
    'auto_review was denied by the reviewer',
  ])('does not blame the CLI version for other failures: %s', (text) => {
    expect(matchErrorPattern(text)?.code).not.toBe('codexCliVersionTooOld');
  });

  it('localizes the Codex CLI version notice with its versions in every supported language', () => {
    const locales = import.meta.glob<{ chat: Record<string, string> }>('../i18n/locales/*.json', {
      eager: true, import: 'default',
    });
    expect(Object.keys(locales)).toHaveLength(10);
    for (const [locale, { chat }] of Object.entries(locales)) {
      expect(chat.codexCliOutdated, locale).toContain('{{version}}');
      expect(chat.codexCliOutdated, locale).toContain('{{minimumVersion}}');
    }
  });

  it('provides localized recovery instructions in every supported language', () => {
    const locales = import.meta.glob<{ errorDiagnostic: Record<string, unknown> }>('../i18n/locales/*.json', {
      eager: true, import: 'default',
    });
    const recoveryPatterns = patternsData.patterns.filter(pattern =>
      pattern.code === 'codexWriterConflict' || pattern.code === 'codexCliVersionTooOld'
        || pattern.code.startsWith('codexThread'));
    expect(Object.keys(locales)).toHaveLength(10);
    for (const [locale, { errorDiagnostic }] of Object.entries(locales)) {
      for (const pattern of recoveryPatterns) {
        const diagnostic = errorDiagnostic[pattern.code] as {
          title: string; intro: string; reason: string;
          solutions: Record<string, Record<string, string>>;
        };
        for (const field of ['title', 'intro', 'reason'] as const) {
          expect(diagnostic?.[field], `${locale}: ${pattern.code}.${field}`).toBeTruthy();
        }
        for (const solution of pattern.solutions) {
          const translated = diagnostic?.solutions?.[solution.key];
          expect(translated?.title, `${locale}: ${pattern.code}.${solution.key}`).toBeTruthy();
          solution.steps.forEach((_, index) => {
            expect(translated?.[`step${index}`], `${locale}: ${pattern.code}.${solution.key}.step${index}`).toBeTruthy();
          });
        }
      }
    }
  });

  it('matches when regex and all keywords are present', () => {
    const text =
      'Error: Native CLI binary for claude-agent-sdk not found in node_modules';
    const result = matchErrorPattern(text);
    expect(result).not.toBeNull();
    expect(result?.code).toBe('sdkNativeBinaryMissing');
    expect(result?.solutions).toHaveLength(2);
  });

  it('matches case-insensitively on the regex portion', () => {
    const text = 'NATIVE CLI BINARY FOR claude-agent-sdk NOT FOUND';
    const result = matchErrorPattern(text);
    expect(result?.code).toBe('sdkNativeBinaryMissing');
  });

  it('returns null when the regex matches but keywords are missing', () => {
    // Regex matches, but the required "claude-agent-sdk" keyword is absent
    const text = 'Native CLI binary for some-other-sdk not found';
    expect(matchErrorPattern(text)).toBeNull();
  });

  it('returns null when no pattern matches the error text', () => {
    expect(matchErrorPattern('Some unrelated error message')).toBeNull();
  });

  it('returns the first pattern whose regex and keywords both match', () => {
    const text =
      'Internal error: Native CLI binary for claude-agent-sdk not found while loading';
    const result = matchErrorPattern(text);
    expect(result?.code).toBe('sdkNativeBinaryMissing');
  });

  it('exposes solutions with the expected step kinds', () => {
    const text =
      'Native CLI binary for claude-agent-sdk not found in installation directory';
    const result = matchErrorPattern(text);
    const switchRegistry = result?.solutions.find((s) => s.key === 'switchRegistry');
    expect(switchRegistry?.recommended).toBe(true);
    expect(switchRegistry?.steps[0]?.kind).toBe('command');
    expect(switchRegistry?.steps[1]?.kind).toBe('navigation');
  });

  it('matches spawn EBUSY error and exposes both solutions', () => {
    const result = matchErrorPattern('Error: spawn EBUSY');
    expect(result?.code).toBe('spawnEbusy');
    expect(result?.solutions).toHaveLength(2);
    const checkNode = result?.solutions.find((s) => s.key === 'checkNodeVersion');
    expect(checkNode?.recommended).toBe(true);
    expect(checkNode?.steps[0]?.kind).toBe('command');
    if (checkNode?.steps[0]?.kind === 'command') {
      expect(checkNode.steps[0].command).toBe('node -v');
    }
    const reinstall = result?.solutions.find((s) => s.key === 'reinstallLatestSdk');
    expect(reinstall?.steps[0]?.kind).toBe('command');
    expect(reinstall?.steps[1]?.kind).toBe('navigation');
  });

  it('matches spawn EBUSY case-insensitively', () => {
    expect(matchErrorPattern('SPAWN EBUSY')?.code).toBe('spawnEbusy');
    expect(matchErrorPattern('something failed: spawn ebusy at line 42')?.code).toBe('spawnEbusy');
  });
  it('matches a Codex CLI startup failure and offers the reinstall path', () => {
    const text = [
      'codex runtime failure: codex app-server exited (code=1, signal=null)',
      '',
      '- /usr/local/bin/codex: codex app-server exited (code=1, signal=null) - spawn ENOENT',
      '- Codex CLI check: run "codex --version"; install or update using https://learn.chatgpt.com/docs/codex/cli#getting-started',
    ].join('\n');
    const result = matchErrorPattern(text);
    expect(result?.code).toBe('codexCliUnavailable');
    expect(result?.solutions).toHaveLength(2);
    const reinstall = result?.solutions.find((s) => s.key === 'reinstallCodexCli');
    expect(reinstall?.recommended).toBe(true);
    expect(reinstall?.steps).toEqual([
      { kind: 'link', url: 'https://learn.chatgpt.com/docs/codex/cli#getting-started' },
      { kind: 'command', command: 'codex --version' },
    ]);
  });

  it('matches the Claude Code minimum version error and offers the in-place SDK update', () => {
    const text = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",'
      + '"message":"Claude Code 2.1.39 does not support this model; version 2.1.280 or newer is required. '
      + 'Run \'claude update\', or update the Claude desktop app, then try again.",'
      + '"details":{"error_code":"claude_code_version_too_old"}},"request_id":"req_0123456789"}';
    const result = matchErrorPattern(text);
    expect(result?.code).toBe('claudeCodeVersionTooOld');
    const updateSdk = result?.solutions.find((s) => s.key === 'updateSdk');
    expect(updateSdk?.recommended).toBe(true);
    expect(updateSdk?.steps).toEqual([{ kind: 'action', action: 'updateClaudeSdk' }]);
    const updateCustomCli = result?.solutions.find((s) => s.key === 'updateCustomCli');
    expect(updateCustomCli?.steps).toEqual([{ kind: 'command', command: 'claude update' }]);
  });

  it('matches the Claude Code minimum version message without the error code', () => {
    const text = 'Claude Code 2.1.39 does not support this model; version 2.1.280 or newer is required.';
    expect(matchErrorPattern(text)?.code).toBe('claudeCodeVersionTooOld');
  });

  it.each([
    'Claude Code process exited with code 3221225785',
    'Claude Code process exited with code -1073741511',
    'Claude Code process exited with code 3221225785. stderr: tail',
    'Cannot write to process that exited with error: Claude Code process exited with code 3221225785',
    'SDK-STDERR:\n```\nnoise\n```\n\nClaude Code process exited with code 3221225785',
    'Claude Code error:\n- Error message: Claude Code process exited with code 3221225785\n- Current API Key source: Not configured',
  ])('diagnoses a Claude Code that Windows refused to load: %s', (text) => {
    expect(matchErrorPattern(text)?.code).toBe('claudeCodeWindowsTooOld');
  });

  it.each([
    'Claude Code process exited with code 1',
    'Claude Code process exited with code 3221225786',
    'Claude Code process exited with code 32212257851',
    'MCP server "foo" process exited with code 3221225785',
    'Hook process exited with code 3221225785',
  ])('does not blame the Windows version for: %s', (text) => {
    expect(matchErrorPattern(text)).toBeNull();
  });

  it('points old Windows at the last SDK that runs on Node.js, in every supported language', () => {
    const locales = import.meta.glob<{
      errorDiagnostic: Record<string, unknown>;
      settings: { basic: { claudeCliPath: { label: string } } };
    }>('../i18n/locales/*.json', {
      eager: true, import: 'default',
    });
    const pattern = patternsData.patterns.find(entry => entry.code === 'claudeCodeWindowsTooOld');
    expect(pattern?.solutions.map(solution => solution.key)).toEqual(['updateWindows', 'useOlderSdk', 'checkCustomCli']);
    expect(Object.keys(locales)).toHaveLength(10);
    for (const [locale, { errorDiagnostic, settings }] of Object.entries(locales)) {
      const diagnostic = errorDiagnostic.claudeCodeWindowsTooOld as {
        title: string; intro: string; reason: string;
        solutions: Record<string, Record<string, string>>;
      };
      expect(diagnostic?.title, `${locale}: title`).toBeTruthy();
      expect(diagnostic?.reason, `${locale}: reason`).toBeTruthy();
      for (const required of ['0xC0000139', '2.1.118', '1809', 'Windows Server 2019']) {
        expect(diagnostic?.intro, `${locale}: intro`).toContain(required);
      }
      for (const solution of pattern?.solutions ?? []) {
        const translated = diagnostic?.solutions?.[solution.key];
        expect(translated?.title, `${locale}: ${solution.key}`).toBeTruthy();
        solution.steps.forEach((_, index) => {
          expect(translated?.[`step${index}`], `${locale}: ${solution.key}.step${index}`).toBeTruthy();
        });
      }
      expect(diagnostic?.solutions?.useOlderSdk?.step0, `${locale}: useOlderSdk`).toContain('v0.2.112');
      expect(diagnostic?.solutions?.checkCustomCli?.step0, `${locale}: checkCustomCli`)
        .toContain(settings.basic.claudeCliPath.label);
    }
  });

  it('does not treat a clean exit line without the CLI hint as a CLI install problem', () => {
    // The bare transport line also appears for ordinary closes; only the
    // runtime failure text carries the actionable hint.
    expect(matchErrorPattern('codex app-server exited (code=0, signal=null)')).toBeNull();
  });
});
