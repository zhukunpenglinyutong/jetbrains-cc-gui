import { describe, expect, it } from 'vitest';
import { matchErrorPattern } from './errorMatcher';

describe('matchErrorPattern', () => {
  it('returns null for empty input', () => {
    expect(matchErrorPattern('')).toBeNull();
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
      '- Codex CLI check: run "codex --version"; reinstall the CLI with "npm install -g @openai/codex@latest"',
    ].join('\n');
    const result = matchErrorPattern(text);
    expect(result?.code).toBe('codexCliUnavailable');
    expect(result?.solutions).toHaveLength(2);
    const reinstall = result?.solutions.find((s) => s.key === 'reinstallCodexCli');
    expect(reinstall?.recommended).toBe(true);
    expect(reinstall?.steps.map((step) => (step.kind === 'command' ? step.command : step.action)))
      .toEqual(['npm uninstall -g @openai/codex', 'npm install -g @openai/codex@latest', 'codex --version']);
  });

  it('does not treat a clean exit line without the CLI hint as a CLI install problem', () => {
    // The bare transport line also appears for ordinary closes; only the
    // runtime failure text carries the actionable hint.
    expect(matchErrorPattern('codex app-server exited (code=0, signal=null)')).toBeNull();
  });
});
